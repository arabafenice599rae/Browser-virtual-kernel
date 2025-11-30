// main.js - Bootstrap del kernel + collegamento UI

import {
  Kernel,
  echoServer,
  echoClient,
  shellProcess,
  psProgram,
  lsProgram,
  netstatProgram,
  helpProgram,
  killProgram,
  catProgram,
  echoFileProgram,
  rmProgram,
} from "./kernel.js";

// ––––– BOOT DEL KERNEL –––––

const kernel = new Kernel({ tickMs: 50 });

// Registra i programmi userland
kernel.registerProgram("echo-server", echoServer);
kernel.registerProgram("echo-client", echoClient);
kernel.registerProgram("shell", shellProcess);
kernel.registerProgram("ps", psProgram);
kernel.registerProgram("ls", lsProgram);
kernel.registerProgram("netstat", netstatProgram);
kernel.registerProgram("help", helpProgram);
kernel.registerProgram("kill", killProgram);
kernel.registerProgram("cat", catProgram);
kernel.registerProgram("echo-file", echoFileProgram);
kernel.registerProgram("rm", rmProgram);

// Avvia shell (porta 9999) e echo server (porta 8080)
kernel.spawn(shellProcess, {
  name: "shell",
  priority: 2,
});

kernel.spawn((sys) => echoServer(sys, 8080), {
  name: "echo-server",
  priority: 2,
});

// Esporta per debug da console
window.kernel = kernel;

// ––––– UI: riferimenti DOM –––––

const processTableBody = document.getElementById("processTableBody");
const portsTableBody = document.getElementById("portsTableBody");
const vfsList = document.getElementById("vfsList");
const logArea = document.getElementById("logArea");

const btnAuto = document.getElementById("btnAuto");
const btnSpawnEchoClient = document.getElementById("btnSpawnEchoClient");
const btnClearLogs = document.getElementById("btnClearLogs");

const shellHistoryEl = document.getElementById("shellHistory");
const shellInputEl = document.getElementById("shellInput");

let autoId = null;
let startTime = null;

// ––––– Funzioni di render –––––

function renderProcesses() {
  const procs = kernel.getProcessTable();
  const now = Date.now();
  processTableBody.innerHTML = "";
  for (const p of procs) {
    const tr = document.createElement("tr");
    const ageSec = ((now - p.spawnTime) / 1000).toFixed(1);

    let priorityClass = "priority-low";
    if (p.priority >= 3) priorityClass = "priority-high";
    else if (p.priority >= 2) priorityClass = "priority-medium";

    let blockLabel = p.blockReason || "-";
    if (p.blockReason === "recv_port") blockLabel = "WAIT_PORT";
    if (p.blockReason === "recv") blockLabel = "WAIT_MSG";
    if (p.blockReason === "sleep") blockLabel = "SLEEP";

    tr.innerHTML = `
      <td>${p.pid}</td>
      <td><strong>${p.name}</strong></td>
      <td class="${priorityClass}">${p.priority}</td>
      <td><span class="state-badge state-${p.state}">${p.state}</span></td>
      <td>${blockLabel}</td>
      <td>${p.exitCode ?? "-"}</td>
      <td>${ageSec}s</td>
    `;
    processTableBody.appendChild(tr);
  }
}

function renderPorts() {
  const ports = kernel.getPortsTable();
  portsTableBody.innerHTML = "";
  for (const p of ports) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><code>${p.port}</code></td>
      <td>PID ${p.ownerPid}</td>
      <td>${
        p.queueLength > 0
          ? `<span class="state-badge state-READY">${p.queueLength}</span>`
          : "-"
      }</td>
    `;
    portsTableBody.appendChild(tr);
  }
}

function renderVFS() {
  const files = kernel.listFiles();
  vfsList.innerHTML = "";
  for (const f of files) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${f.path}</strong> <span style="color: var(--text-secondary)">(${f.size} bytes)</span> — <code>${f.preview}</code>`;
    vfsList.appendChild(li);
  }
}

function renderLogs() {
  const logs = kernel.getLogs();
  logArea.textContent = logs
    .map((l) => `[t=${l.time}] [PID ${l.pid}] ${l.msg}`)
    .join("\n");
  logArea.scrollTop = logArea.scrollHeight;
}

function updateStatsDisplay() {
  const procs = kernel.getProcessTable();
  const ports = kernel.getPortsTable();
  const files = kernel.listFiles();

  const uptime = startTime
    ? Math.floor((Date.now() - startTime) / 1000)
    : 0;
  const uptimeStr =
    uptime >= 60
      ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
      : `${uptime}s`;

  if (window.updateStats) {
    window.updateStats(procs.length, ports.length, files.length, uptimeStr);
  }
}

// Shell UI history
function appendShellHistory(line) {
  const div = document.createElement("div");
  div.textContent = line;
  shellHistoryEl.appendChild(div);
  shellHistoryEl.scrollTop = shellHistoryEl.scrollHeight;
}

// ––––– Kernel tick + UI refresh –––––

function oneTick() {
  kernel.tick();
  kernel.cleanupTerminated();
  renderProcesses();
  renderPorts();
  renderVFS();
  renderLogs();
  updateStatsDisplay();
}

// ––––– Programma: shell-client per un comando –––––

function makeShellClientProgram(line) {
  return function* shellClient(sys) {
    const myPid = yield sys.getPid();
    yield sys.log(`Shell client ${myPid}: comando "${line}"`);

    yield sys.sendToPort(9999, { command: line, from: myPid });

    const reply = yield sys.recv();
    if (reply && reply.payload && reply.payload.type === "SHELL_RESULT") {
      const out = reply.payload.output;
      yield sys.log(`Shell result: ${out}`);
      appendShellHistory(`→ ${out}`);
    } else {
      yield sys.log("Shell result: nessuna risposta");
      appendShellHistory("→ nessuna risposta");
    }
    yield sys.exit(0);
  };
}

// ––––– Eventi UI –––––

btnAuto.onclick = () => {
  if (autoId === null) {
    autoId = setInterval(oneTick, 50);
    startTime = Date.now();
    btnAuto.innerHTML = "⏸️ Stop Kernel";
    window.updateStatus && window.updateStatus(true);
  } else {
    clearInterval(autoId);
    autoId = null;
    btnAuto.innerHTML = "▶️ Start Kernel";
    window.updateStatus && window.updateStatus(false);
  }
};

btnClearLogs.onclick = () => {
  kernel.logs = [];
  renderLogs();
  appendShellHistory("→ Logs cleared");
};

btnSpawnEchoClient.onclick = () => {
  kernel.spawn((sys) => echoClient(sys, 8080, "hello-from-ui"), {
    name: "echo-client",
    priority: 1,
  });
  oneTick();
};

shellInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const line = shellInputEl.value.trim();
    if (!line) return;

    appendShellHistory(`$ ${line}`);
    shellInputEl.value = "";

    kernel.spawn(makeShellClientProgram(line), {
      name: "shell-client",
      priority: 1,
    });
    oneTick();
  }
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  // Ctrl/Cmd + L = Clear logs
  if ((e.ctrlKey || e.metaKey) && e.key === "l") {
    e.preventDefault();
    kernel.logs = [];
    renderLogs();
    appendShellHistory("→ Logs cleared (Ctrl+L)");
  }

  // Ctrl/Cmd + K = Focus shell
  if ((e.ctrlKey || e.metaKey) && e.key === "k") {
    e.preventDefault();
    shellInputEl.focus();
  }
});

// ––––– Primo render –––––

renderProcesses();
renderPorts();
renderVFS();
renderLogs();
updateStatsDisplay();
appendShellHistory("🚀 Shell ready. Type 'help' for commands");
appendShellHistory("📌 Shortcuts: Ctrl+L (clear logs), Ctrl+K (focus shell)");
appendShellHistory("");

// Focus shell input on load
setTimeout(() => shellInputEl.focus(), 100);
