/**
 * server.js — 批量 IP 在线解析网站（含前后端）
 *
 * 功能：
 *  - 前端：文本框/文件上传输入（支持 IPv4/IPv6，最多 6000 条），进度条，结果表格，CSV 导出。
 *  - 后端：/api/lookup 接口，基于 ip-api.com 批量接口（每次 <=100 条）聚合查询并限流。
 *  - 一键启动：node server.js；打开 http://localhost:3000。
 *
 * 重要说明：
 *  - ip-api 免费版仅支持 HTTP，不支持 HTTPS；本服务端负责转发（避免浏览器的 Mixed Content/CORS 问题）。
 *  - 默认速率：每个批次之间 sleep 750ms（可按需调整）。
 *  - 依赖：Node 18+（内置 fetch）。若低版本 Node，请安装 node-fetch 并将 fetch 替换为 require('node-fetch')。
 */

const express = require('express');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const MAX_IPS = 6000;
const BATCH_SIZE = 100; // ip-api 批量最大 100
const SLEEP_MS = 750;   // 控制速率，避免被限流（按需调整）
const IPAPI_URL = 'http://ip-api.com/batch?fields=status,message,query,country,regionName,city,isp,org,lat,lon';

// 简单的 sleep
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 校验 IP（宽松版：仅做基本格式/字符校验，不做 CIDR/私网剔除）
function isLikelyIP(s) {
  if (!s) return false;
  // 去除包裹的 []（常见于 IPv6 URL 形式）
  const t = s.trim().replace(/^\[/, '').replace(/\]$/, '');
  // IPv4 粗略判断
  const isIPv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(t);
  // IPv6 粗略判断（包含 :: 压缩的情况）
  const isIPv6 = /:/.test(t) && /^[0-9a-fA-F:]+$/.test(t);
  return isIPv4 || isIPv6;
}

// 将输入文本/数组标准化为 IP 数组（去重、过滤非法）
function normalizeIPs(input) {
  let list = [];
  if (Array.isArray(input)) {
    list = input;
  } else if (typeof input === 'string') {
    list = input
      .split(/\r?\n|,|\s+/)
      .map(s => s.trim())
      .filter(Boolean);
  }
  // 过滤非 IP、去重
  const uniq = Array.from(new Set(list.filter(isLikelyIP)));
  if (uniq.length === 0) return { ips: [], rejected: list }; // 全部非法
  return { ips: uniq, rejected: list.filter(x => !isLikelyIP(x)) };
}

// 按 100 一批调用 ip-api 批量接口
async function lookupIPs(ips, onProgress = () => {}) {
  const results = [];
  for (let i = 0; i < ips.length; i += BATCH_SIZE) {
    const batch = ips.slice(i, i + BATCH_SIZE);
    // ip-api 批量 POST 的 body：字符串数组 或 对象数组均可；这里用字符串数组
    const resp = await fetch(IPAPI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch)
    });
    if (!resp.ok) {
      // 写入占位错误，保持返回长度一致
      const errArr = batch.map(ip => ({ query: ip, status: 'fail', message: `HTTP ${resp.status}` }));
      results.push(...errArr);
    } else {
      const json = await resp.json();
      results.push(...json);
    }
    onProgress(Math.min(ips.length, i + batch.length), ips.length);
    // 限速
    if (i + BATCH_SIZE < ips.length) {
      await sleep(SLEEP_MS);
    }
  }
  return results;
}

// API：批量查询
app.post('/api/lookup', async (req, res) => {
  try {
    const { input } = req.body || {};
    const { ips, rejected } = normalizeIPs(input || '');

    if (!ips.length) {
      return res.status(400).json({ error: '未检测到有效 IP，请检查输入。', rejected });
    }
    if (ips.length > MAX_IPS) {
      return res.status(400).json({ error: `单次最多 ${MAX_IPS} 个 IP，当前 ${ips.length} 个。` });
    }

    // 查询并实时记录进度（这里简化：查询完成后返回总结果与被拒条目）
    const results = await lookupIPs(ips);

    res.json({ total: ips.length, rejected, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

// 首页：内置前端页面
app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>批量 IP 在线解析</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-800">
  <div class="max-w-6xl mx-auto p-6">
    <h1 class="text-2xl md:text-3xl font-bold mb-4">批量 IP 在线解析</h1>
    <p class="text-sm text-gray-600 mb-6">支持 IPv4/IPv6，单次最多 6000 条。服务端通过 <code>ip-api.com</code> 批量接口解析。</p>

    <div class="grid md:grid-cols-3 gap-4 items-start">
      <div class="md:col-span-2">
        <textarea id="ipInput" class="w-full h-56 p-3 border rounded-2xl focus:outline-none focus:ring shadow" placeholder="每行一个 IP，或用逗号/空格分隔"></textarea>
        <div class="flex items-center gap-3 mt-3">
          <input type="file" id="fileInput" accept=".txt,.csv" class="block text-sm" />
          <button id="parseBtn" class="px-4 py-2 rounded-2xl bg-black text-white shadow">开始解析</button>
          <button id="clearBtn" class="px-4 py-2 rounded-2xl bg-white border shadow">清空</button>
        </div>
        <p id="hint" class="text-xs text-gray-500 mt-2">提示：可直接粘贴 6000 行以内 IP，或上传 .txt/.csv 文件。</p>
      </div>
      <div class="md:col-span-1 p-4 bg-white rounded-2xl border shadow">
        <h2 class="font-semibold mb-2">进度</h2>
        <div class="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
          <div id="bar" class="bg-gray-800 h-3 w-0"></div>
        </div>
        <div id="progressText" class="text-sm mt-2">等待开始…</div>
        <div id="rejectedWrap" class="text-xs text-yellow-700 mt-3 hidden"></div>
        <div class="mt-4 flex gap-2">
          <button id="exportCsv" class="px-3 py-2 rounded-2xl bg-white border shadow disabled:opacity-50" disabled>导出 CSV</button>
          <button id="copyJson" class="px-3 py-2 rounded-2xl bg-white border shadow disabled:opacity-50" disabled>复制 JSON</button>
        </div>
      </div>
    </div>

    <div class="mt-6">
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-lg font-semibold">解析结果</h2>
        <label class="text-sm text-gray-500"><input id="onlySuccess" type="checkbox" class="mr-1">仅显示成功</label>
      </div>
      <div class="overflow-auto bg-white rounded-2xl border shadow">
        <table class="min-w-full text-sm" id="resultTable">
          <thead class="bg-gray-100">
            <tr>
              <th class="px-3 py-2 border-b text-left">IP</th>
              <th class="px-3 py-2 border-b text-left">状态</th>
              <th class="px-3 py-2 border-b text-left">国家</th>
              <th class="px-3 py-2 border-b text-left">省/州</th>
              <th class="px-3 py-2 border-b text-left">城市</th>
              <th class="px-3 py-2 border-b text-left">ISP</th>
              <th class="px-3 py-2 border-b text-left">组织</th>
              <th class="px-3 py-2 border-b text-left">纬度</th>
              <th class="px-3 py-2 border-b text-left">经度</th>
              <th class="px-3 py-2 border-b text-left">错误信息</th>
            </tr>
          </thead>
          <tbody id="tbody"></tbody>
        </table>
      </div>
    </div>

    <footer class="text-xs text-gray-500 mt-6">注意：ip-api 免费版数据存在精度/限速限制；如需更高 SLA 可切换付费或自建离线库（MaxMind）。</footer>
  </div>

  <script>
    const MAX_IPS = ${MAX_IPS};
    const ta = document.getElementById('ipInput');
    const fileInput = document.getElementById('fileInput');
    const btn = document.getElementById('parseBtn');
    const clearBtn = document.getElementById('clearBtn');
    const bar = document.getElementById('bar');
    const progressText = document.getElementById('progressText');
    const tbody = document.getElementById('tbody');
    const onlySuccess = document.getElementById('onlySuccess');
    const exportCsvBtn = document.getElementById('exportCsv');
    const copyJsonBtn = document.getElementById('copyJson');
    const rejectedWrap = document.getElementById('rejectedWrap');

    let lastResults = [];

    function setProgress(done, total) {
      if (!total) total = 0;
      const pct = total ? Math.round(done * 100 / total) : 0;
      bar.style.width = pct + '%';
      progressText.textContent = total ? `已完成 ${done}/${total}（${pct}%）` : '等待开始…';
    }

    function parseCsvLine(v) {
      if (v == null) return '';
      const s = String(v);
      if (/[",\n]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }

    function toCSV(rows) {
      const header = ['IP','状态','国家','省/州','城市','ISP','组织','纬度','经度','错误信息'];
      const lines = [header.map(parseCsvLine).join(',')];
      for (const r of rows) {
        const line = [
          r.query || '', r.status || '', r.country || '', r.regionName || '', r.city || '', r.isp || '', r.org || '', r.lat ?? '', r.lon ?? '', r.message || ''
        ].map(parseCsvLine).join(',');
        lines.push(line);
      }
      return lines.join('\n');
    }

    function renderTable(rows) {
      tbody.innerHTML = '';
      const filtered = onlySuccess.checked ? rows.filter(r => r.status === 'success') : rows;
      for (const r of filtered) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="px-3 py-2 border-b whitespace-nowrap">${r.query || ''}</td>
          <td class="px-3 py-2 border-b">${r.status || ''}</td>
          <td class="px-3 py-2 border-b">${r.country || ''}</td>
          <td class="px-3 py-2 border-b">${r.regionName || ''}</td>
          <td class="px-3 py-2 border-b">${r.city || ''}</td>
          <td class="px-3 py-2 border-b">${r.isp || ''}</td>
          <td class="px-3 py-2 border-b">${r.org || ''}</td>
          <td class="px-3 py-2 border-b">${r.lat ?? ''}</td>
          <td class="px-3 py-2 border-b">${r.lon ?? ''}</td>
          <td class="px-3 py-2 border-b text-red-600">${r.message || ''}</td>
        `;
        tbody.appendChild(tr);
      }
    }

    onlySuccess.addEventListener('change', () => renderTable(lastResults));

    clearBtn.addEventListener('click', () => {
      ta.value = '';
      tbody.innerHTML = '';
      setProgress(0, 0);
      rejectedWrap.classList.add('hidden');
      exportCsvBtn.disabled = true;
      copyJsonBtn.disabled = true;
    });

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      const joiner = ta.value && !ta.value.endsWith('\n') ? '\n' : '';
      ta.value += joiner + text;
    });

    btn.addEventListener('click', async () => {
      const input = ta.value;
      setProgress(0, 0);
      tbody.innerHTML = '';
      progressText.textContent = '解析中…';
      exportCsvBtn.disabled = true;
      copyJsonBtn.disabled = true;
      rejectedWrap.classList.add('hidden');

      try {
        const resp = await fetch('/api/lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input })
        });
        const data = await resp.json();
        if (!resp.ok) {
          progressText.textContent = data.error || '解析失败';
          return;
        }
        lastResults = data.results || [];
        setProgress(data.total || lastResults.length, data.total || lastResults.length);
        renderTable(lastResults);
        progressText.textContent = `完成：共 ${data.total} 条`;
        exportCsvBtn.disabled = false;
        copyJsonBtn.disabled = false;

        if (data.rejected && data.rejected.length) {
          rejectedWrap.classList.remove('hidden');
          rejectedWrap.textContent = `已忽略 ${data.rejected.length} 条非 IP 内容（例如：${data.rejected.slice(0,5).join('、')}${data.rejected.length>5?'…':''}）`;
        }
      } catch (e) {
        console.error(e);
        progressText.textContent = '网络或服务器错误';
      }
    });

    exportCsvBtn.addEventListener('click', () => {
      const csv = toCSV(lastResults);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ip_lookup_results.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });

    copyJsonBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(lastResults, null, 2));
        copyJsonBtn.textContent = '已复制';
        setTimeout(() => (copyJsonBtn.textContent = '复制 JSON'), 1200);
      } catch {
        alert('复制失败，请手动选择文本复制');
      }
    });
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Batch IP Lookup running on http://localhost:${PORT}`);
});
