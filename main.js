// main.js
import {
  Kernel,
  echoServer,
  echoClient,
  shellProcess,
  psProgram,
  lsProgram,
  netstatProgram,
} from "./kernel.js";

// ---------- Kernel boot ----------

const kernel = new Kernel({ tickMs: 50 });

// register programs
kernel.registerProgram("echo-server", echoServer);
kernel.registerProgram("echo-client", echoClient);
kernel.registerProgram("shell", shellProcess);
kernel.registerProgram("ps", psProgram);
kernel.registerProgram("ls", lsProgram);
kernel.registerProgram("netstat", netstatProgram);

// start shell (port 9999) and echo server on 8080
kernel.spawn(shellProcess, {
  name: "shell",
  priority: 2,
});
kernel.spawn((sys) => echoServer(sys, 8080), {
  name: "echo-server",
  priority: 2,
});

// export for debug
window.kernel = kernel;

// ---------- DOM refs ----------

const processTableBody = document.getElementById("processTableBody");
const portsTableBody = document.getElementById("portsTableBody");
const vfsList = document.getElementById("vfsList");
const logArea = document.getElementById("logArea");

const btnAuto = document.getElementById("btnAuto");
const btnSpawnEchoClient = document.getElementById("btnSpawnEchoClient");

const shellHistoryEl = document.getElementById("shellHistory");
const shellInputEl = document.getElementById("shellInput");

let autoId = null;

// ---------- Render helpers ----------

function renderProcesses() {
  const procs = kernel.getProcessTable();
  const now = Date.now();
  processTableBody.innerHTML = "";
  for (const p of procs) {
    const tr = document.createElement("tr");
    const ageSec = ((now - p.spawnTime) / 1000).toFixed(1);
    tr.innerHTML = `
      <td>${p.pid}</td>
      <td>${p.name}</td>
      <td>${p.priority}</td>
      <td>${p.state}</td>
      <td>${p.blockReason || "-"}</td>
      <td>${p.exitCode ?? "-"}</td>
      <td>${ageSec}</td>
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
      <td>${p.port}</td>
      <td>${p.ownerPid}</td>
      <td>${p.queueLength}</td>
    `;
    portsTableBody.appendChild(tr);
  }
}

function renderVFS() {
  const files = kernel.listFiles();
  vfsList.innerHTML = "";
  for (const f of files) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${f.path}</strong> (${f.size} bytes) – <code>${f.preview}</code>`;
    vfsList.appendChild(li);
  }
}

function renderLogs() {
  const logs = kernel.getLogs();
  logArea.textContent = logs
    .map((l) => `[t=${l.time}] [PID=${l.pid}] ${l.msg}`)
    .join("\n");
}

function appendShellHistory(line) {
  const div = document.createElement("div");
  div.textContent = line;
  shellHistoryEl.appendChild(div);
  shellHistoryEl.scrollTop = shellHistoryEl.scrollHeight;
}

// ---------- Kernel tick ----------

function oneTick() {
  kernel.tick();
  kernel.cleanupTerminated();
  renderProcesses();
  renderPorts();
  renderVFS();
  renderLogs();
}

// ---------- Shell client program ----------

function makeShellClientProgram(line) {
  return function* shellClient(sys) {
    const myPid = yield sys.getPid();
    yield sys.log(`Shell client ${myPid}: command "${line}"`);
    yield sys.sendToPort(9999, { command: line, from: myPid });

    const reply = yield sys.recv();
    if (reply && reply.payload && reply.payload.type === "SHELL_RESULT") {
      const out = reply.payload.output;
      yield sys.log(`Shell result: ${out}`);
    } else {
      yield sys.log("Shell result: no reply");
    }
    yield sys.exit(0);
  };
}

// ---------- UI events ----------

btnAuto.onclick = () => {
  if (autoId === null) {
    autoId = setInterval(oneTick, 50);
    btnAuto.textContent = "Stop kernel";
  } else {
    clearInterval(autoId);
    autoId = null;
    btnAuto.textContent = "Start/stop kernel";
  }
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

// ---------- Initial render ----------

renderProcesses();
renderPorts();
renderVFS();
renderLogs();
appendShellHistory(
  "Shell ready. Example: echo-client 8080 hello, ps, ls, netstat"
);
