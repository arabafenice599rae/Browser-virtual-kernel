// kernel.js - Browser Virtual Kernel (full version)

// ------------------ Process & kernel core ------------------

export const ProcessState = {
  READY: "READY",
  RUNNING: "RUNNING",
  BLOCKED: "BLOCKED",
  TERMINATED: "TERMINATED",
};

let KERNEL_INSTANCE_COUNTER = 0;

export class Kernel {
  constructor({ tickMs = 50 } = {}) {
    this.id = ++KERNEL_INSTANCE_COUNTER;
    this.tickMs = tickMs;
    this.timeMs = 0;

    this.processes = [];
    this.nextPid = 1;

    this.logs = [];

    this.mailbox = new Map(); // pid -> [{fromPid, payload}]
    this.ports = new Map();   // port -> { ownerPid, queue: [{fromPid, payload}] }

    this.programRegistry = new Map();

    this.vfs = new Map();
    this._restoreVfsFromStorage();
    if (!this.vfs.has("/etc/motd")) {
      this._writeFile("/etc/motd", "Benvenuto nel mini-kernel in JS!");
    }
  }

  // ---------- Public API for UI ----------

  registerProgram(name, fn) {
    this.programRegistry.set(name, fn);
  }

  spawn(program, opts = {}) {
    return this._spawnInternal(program, opts);
  }

  tick() {
    this.timeMs += this.tickMs;
    for (const pcb of this.processes) {
      if (pcb.state === ProcessState.READY || pcb.state === ProcessState.RUNNING) {
        this._runProcess(pcb);
      }
    }
  }

  cleanupTerminated() {
    this.processes = this.processes.filter((p) => p.state !== ProcessState.TERMINATED);
  }

  getProcessTable() {
    return this.processes.map((p) => ({
      pid: p.pid,
      name: p.name,
      priority: p.priority,
      state: p.state,
      blockReason: p.blockReason,
      exitCode: p.exitCode,
      spawnTime: p.spawnTime,
    }));
  }

  getPortsTable() {
    const arr = [];
    for (const [port, entry] of this.ports.entries()) {
      arr.push({
        port,
        ownerPid: entry.ownerPid,
        queueLength: entry.queue.length,
      });
    }
    arr.sort((a, b) => a.port - b.port);
    return arr;
  }

  listFiles() {
    const out = [];
    for (const [path, meta] of this.vfs.entries()) {
      const text = meta.content ?? "";
      const preview =
        text.length > 60 ? text.slice(0, 57).replace(/\s+/g, " ") + "..." : text;
      out.push({
        path,
        size: text.length,
        preview,
      });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  getLogs() {
    return this.logs.slice(-500);
  }

  // ---------- Internal helpers ----------

  _spawnInternal(program, opts = {}) {
    const pid = this.nextPid++;
    const pcb = {
      pid,
      name: opts.name || `proc-${pid}`,
      priority: opts.priority ?? 1,
      state: ProcessState.READY,
      blockReason: null,
      exitCode: null,
      program,
      iterator: null,
      waitingFor: null,
      nextValue: undefined,
      spawnTime: Date.now(),
    };

    const sys = this._createSyscalls(pcb);
    try {
      pcb.iterator = program(sys);
    } catch (err) {
      this._log(pcb.pid, `Error starting program: ${String(err)}`);
      pcb.state = ProcessState.TERMINATED;
      pcb.exitCode = 1;
      return pid;
    }

    this.processes.push(pcb);
    return pid;
  }

  _findPcb(pid) {
    return this.processes.find((p) => p.pid === pid) || null;
  }

  _runProcess(pcb) {
    if (!pcb.iterator || pcb.state === ProcessState.TERMINATED) return;

    pcb.state = ProcessState.RUNNING;
    const input = pcb.nextValue;
    pcb.nextValue = undefined;

    let result;
    try {
      result = pcb.iterator.next(input);
    } catch (err) {
      this._log(pcb.pid, `Process crashed: ${String(err)}`);
      pcb.state = ProcessState.TERMINATED;
      pcb.blockReason = null;
      pcb.exitCode = 1;
      return;
    }

    if (result.done) {
      pcb.state = ProcessState.TERMINATED;
      pcb.blockReason = null;
      pcb.exitCode = typeof result.value === "number" ? result.value : 0;
      return;
    }

    const syscall = result.value || {};
    this._handleSyscall(pcb, syscall);
  }

  _handleSyscall(pcb, syscall) {
    switch (syscall.type) {
      case "SLEEP": {
        const until = this.timeMs + (syscall.ms || 0);
        pcb.blockReason = "sleep";
        pcb.state = ProcessState.BLOCKED;
        pcb.waitingFor = { type: "SLEEP", until };
        break;
      }

      case "LOG": {
        this._log(pcb.pid, syscall.message ?? "");
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.nextValue = true;
        break;
      }

      case "GET_PID": {
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.nextValue = pcb.pid;
        break;
      }

      case "SEND": {
        const target = this._findPcb(syscall.toPid);
        if (target) {
          const queue = this.mailbox.get(target.pid) || [];
          const msg = { fromPid: pcb.pid, payload: syscall.payload };
          queue.push(msg);
          this.mailbox.set(target.pid, queue);

          if (
            target.state === ProcessState.BLOCKED &&
            target.blockReason === "recv" &&
            queue.length > 0
          ) {
            const deliver = queue.shift();
            this.mailbox.set(target.pid, queue);
            target.state = ProcessState.READY;
            target.blockReason = null;
            target.nextValue = deliver;
          }
        }
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.nextValue = true;
        break;
      }

      case "RECV": {
        const queue = this.mailbox.get(pcb.pid) || [];
        if (queue.length > 0) {
          const msg = queue.shift();
          this.mailbox.set(pcb.pid, queue);
          pcb.state = ProcessState.READY;
          pcb.blockReason = null;
          pcb.nextValue = msg;
        } else {
          pcb.state = ProcessState.BLOCKED;
          pcb.blockReason = "recv";
          pcb.waitingFor = { type: "RECV" };
        }
        break;
      }

      case "LISTEN": {
        const port = Number(syscall.port);
        const existing = this.ports.get(port);
        if (existing && existing.ownerPid !== pcb.pid) {
          pcb.state = ProcessState.READY;
          pcb.blockReason = null;
          pcb.nextValue = false;
        } else {
          const entry = existing || { ownerPid: pcb.pid, queue: [] };
          entry.ownerPid = pcb.pid;
          this.ports.set(port, entry);
          pcb.state = ProcessState.READY;
          pcb.blockReason = null;
          pcb.nextValue = true;
        }
        break;
      }

      case "SEND_PORT": {
        const port = Number(syscall.port);
        const entry = this.ports.get(port);
        if (entry) {
          const msg = { fromPid: pcb.pid, payload: syscall.payload };
          entry.queue.push(msg);
          const target = this._findPcb(entry.ownerPid);
          if (
            target &&
            target.state === ProcessState.BLOCKED &&
            target.blockReason === "recv_port" &&
            entry.queue.length > 0
          ) {
            const deliver = entry.queue.shift();
            target.state = ProcessState.READY;
            target.blockReason = null;
            target.nextValue = deliver;
          }
        }
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.nextValue = true;
        break;
      }

      case "RECV_PORT": {
        const port = Number(syscall.port);
        const entry = this.ports.get(port);
        if (entry && entry.queue.length > 0) {
          const msg = entry.queue.shift();
          pcb.state = ProcessState.READY;
          pcb.blockReason = null;
          pcb.nextValue = msg;
        } else {
          pcb.state = ProcessState.BLOCKED;
          pcb.blockReason = "recv_port";
          pcb.waitingFor = { type: "RECV_PORT", port };
        }
        break;
      }

      case "SPAWN": {
        const childPid = this._spawnInternal(syscall.program, syscall.opts || {});
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.nextValue = childPid;
        break;
      }

      case "EXIT": {
        pcb.state = ProcessState.TERMINATED;
        pcb.blockReason = null;
        pcb.exitCode =
          typeof syscall.code === "number" ? syscall.code : pcb.exitCode ?? 0;
        break;
      }

      case "PS": {
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.nextValue = this.getProcessTable();
        break;
      }

      case "LIST_FILES": {
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.nextValue = this.listFiles();
        break;
      }

      case "READ_FILE": {
        const path = syscall.path || "";
        const meta = this.vfs.get(path) || null;
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.nextValue = meta ? meta.content : null;
        break;
      }

      case "WRITE_FILE": {
        const path = syscall.path || "";
        const text = String(syscall.text ?? "");
        this._writeFile(path, text);
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.nextValue = text.length;
        break;
      }

      case "UNLINK": {
        const path = syscall.path || "";
        const ok = this._unlinkFile(path);
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.nextValue = ok;
        break;
      }

      case "LIST_PORTS": {
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.nextValue = this.getPortsTable();
        break;
      }

      case "KILL": {
        const target = this._findPcb(syscall.targetPid);
        if (target) {
          this._log(
            pcb.pid,
            `Sending ${syscall.signal || "TERM"} to pid=${target.pid}`
          );
          target.state = ProcessState.TERMINATED;
          target.blockReason = null;
          target.exitCode = -1;
        }
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.nextValue = true;
        break;
      }

      default: {
        this._log(pcb.pid, `Unknown syscall: ${String(syscall.type)}`);
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.nextValue = null;
        break;
      }
    }

    // wake sleeping processes
    for (const p of this.processes) {
      if (
        p.state === ProcessState.BLOCKED &&
        p.waitingFor &&
        p.waitingFor.type === "SLEEP" &&
        this.timeMs >= p.waitingFor.until
      ) {
        p.state = ProcessState.READY;
        p.blockReason = null;
        p.waitingFor = null;
        p.nextValue = true;
      }
    }
  }

  _log(pid, msg) {
    const entry = {
      time: Date.now(),
      pid,
      msg,
    };
    this.logs.push(entry);
    if (this.logs.length > 1000) {
      this.logs.shift();
    }
  }

  // ---------- VFS helpers ----------

  _writeFile(path, content) {
    const now = Date.now();
    const normPath = path.startsWith("/") ? path : `/${path}`;
    const meta = this.vfs.get(normPath) || {
      path: normPath,
      createdAt: now,
      updatedAt: now,
      content: "",
    };
    meta.content = String(content);
    meta.updatedAt = now;
    this.vfs.set(normPath, meta);
    this._saveVfsToStorage();
  }

  _unlinkFile(path) {
    const normPath = path.startsWith("/") ? path : `/${path}`;
    const existed = this.vfs.delete(normPath);
    this._saveVfsToStorage();
    return existed;
  }

  _saveVfsToStorage() {
    try {
      const obj = {};
      for (const [path, meta] of this.vfs.entries()) {
        obj[path] = {
          path: meta.path,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          content: meta.content,
        };
      }
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("bvkernel_vfs", JSON.stringify(obj));
      }
    } catch {
      // ignore
    }
  }

  _restoreVfsFromStorage() {
    try {
      if (typeof localStorage === "undefined") return;
      const raw = localStorage.getItem("bvkernel_vfs");
      if (!raw) return;
      const obj = JSON.parse(raw);
      for (const [path, meta] of Object.entries(obj)) {
        this.vfs.set(path, {
          path,
          createdAt: meta.createdAt || Date.now(),
          updatedAt: meta.updatedAt || meta.createdAt || Date.now(),
          content: meta.content || "",
        });
      }
    } catch {
      // ignore
    }
  }

  // ---------- Syscall factory ----------

  _createSyscalls(pcb) {
    const kernel = this;
    return {
      *sleep(ms) {
        return yield { type: "SLEEP", ms };
      },
      *log(message) {
        return yield { type: "LOG", message };
      },
      *getPid() {
        return yield { type: "GET_PID" };
      },
      *send(toPid, payload) {
        return yield { type: "SEND", toPid, payload };
      },
      *recv() {
        return yield { type: "RECV" };
      },
      *listen(port) {
        return yield { type: "LISTEN", port };
      },
      *sendToPort(port, payload) {
        return yield { type: "SEND_PORT", port, payload };
      },
      *recvFromPort(port) {
        return yield { type: "RECV_PORT", port };
      },
      *spawn(program, opts = {}) {
        return yield { type: "SPAWN", program, opts };
      },
      *exit(code = 0) {
        return yield { type: "EXIT", code };
      },
      *ps() {
        return yield { type: "PS" };
      },
      *listFiles() {
        return yield { type: "LIST_FILES" };
      },
      *readFile(path) {
        return yield { type: "READ_FILE", path };
      },
      *writeFile(path, text) {
        return yield { type: "WRITE_FILE", path, text };
      },
      *unlink(path) {
        return yield { type: "UNLINK", path };
      },
      *listPorts() {
        return yield { type: "LIST_PORTS" };
      },
      *kill(targetPid, signal = "TERM") {
        return yield { type: "KILL", targetPid, signal };
      },
      // access to kernel for debug, if serve
      get kernel() {
        return kernel;
      },
    };
  }
}

// ------------------ Userland programs ------------------

// Echo server on a virtual port
export function* echoServer(sys, port = 8080) {
  const ok = yield* sys.listen(port);
  if (!ok) {
    yield* sys.log(`Echo server: port ${port} already in use`);
    yield* sys.exit(1);
    return;
  }
  const myPid = yield* sys.getPid();
  yield* sys.log(`Echo server listening on port ${port}`);

  while (true) {
    const msg = yield* sys.recvFromPort(port);
    if (!msg) continue;
    const { fromPid, payload } = msg;
    yield* sys.log(
      `Echo server: from PID ${fromPid} -> ${JSON.stringify(payload)}`
    );
    if (payload && typeof payload.text === "string") {
      yield* sys.send(fromPid, {
        type: "ECHO_REPLY",
        text: payload.text,
        from: myPid,
      });
    } else {
      yield* sys.send(fromPid, {
        type: "ECHO_REPLY",
        text: "[no text]",
        from: myPid,
      });
    }
  }
}

// Echo client: send a message to a port and wait for reply
export function* echoClient(sys, port = 8080, text = "hello-from-client") {
  const myPid = yield* sys.getPid();
  yield* sys.log(`Client ${myPid}: send to port ${port}: ${text}`);
  yield* sys.sendToPort(port, { text, from: myPid });
  const reply = yield* sys.recv();
  yield* sys.log(`Client ${myPid}: reply = ${JSON.stringify(reply?.payload)}`);
  yield* sys.exit(0);
}

// ps: show process table
export function* psProgram(sys) {
  const table = yield* sys.ps();
  yield* sys.log("=== ps ===");
  for (const p of table) {
    yield* sys.log(
      `pid=${p.pid} name=${p.name} prio=${p.priority} state=${p.state} block=${p.blockReason || "-"}`
    );
  }
  yield* sys.exit(0);
}

// ls: list virtual file system
export function* lsProgram(sys) {
  const files = yield* sys.listFiles();
  yield* sys.log("=== ls (VFS) ===");
  for (const f of files) {
    yield* sys.log(`${f.path} (${f.size} bytes)`);
  }
  yield* sys.exit(0);
}

// netstat: list ports
export function* netstatProgram(sys) {
  const ports = yield* sys.listPorts();
  yield* sys.log("=== netstat ===");
  for (const p of ports) {
    yield* sys.log(
      `port=${p.port} ownerPid=${p.ownerPid} queue=${p.queueLength}`
    );
  }
  yield* sys.exit(0);
}

// cat: print file contents
export function* catProgram(sys, path) {
  if (!path) {
    yield* sys.log("cat: missing path");
    yield* sys.exit(1);
    return;
  }
  const text = yield* sys.readFile(path);
  if (text == null) {
    yield* sys.log(`cat: ${path}: no such file`);
    yield* sys.exit(1);
    return;
  }
  yield* sys.log(`=== cat ${path} ===`);
  yield* sys.log(text);
  yield* sys.exit(0);
}

// echo-file: write arbitrary text to a file
export function* echoFileProgram(sys, path, ...textParts) {
  if (!path) {
    yield* sys.log("echo-file: missing path");
    yield* sys.exit(1);
    return;
  }
  const text = textParts.join(" ");
  const bytes = yield* sys.writeFile(path, text);
  yield* sys.log(`echo-file: wrote ${bytes} chars to ${path}`);
  yield* sys.exit(0);
}

// rm: delete a file
export function* rmProgram(sys, path) {
  if (!path) {
    yield* sys.log("rm: missing path");
    yield* sys.exit(1);
    return;
  }
  const ok = yield* sys.unlink(path);
  if (ok) {
    yield* sys.log(`rm: removed ${path}`);
    yield* sys.exit(0);
  } else {
    yield* sys.log(`rm: ${path}: no such file`);
    yield* sys.exit(1);
  }
}

// kill: terminate a process
export function* killProgram(sys, targetPid, signal = "TERM") {
  if (!targetPid && targetPid !== 0) {
    yield* sys.log("kill: missing pid");
    yield* sys.exit(1);
    return;
  }
  yield* sys.kill(Number(targetPid), signal);
  yield* sys.exit(0);
}

// help: list commands
export function* helpProgram(sys) {
  yield* sys.log("Available commands:");
  yield* sys.log(
    "  echo-client <port> <msg>    - send message to a server"
  );
  yield* sys.log("  echo-server <port>          - start echo server on port");
  yield* sys.log("  ps                          - show process table");
  yield* sys.log("  ls                          - list virtual file system");
  yield* sys.log("  netstat                     - show open ports");
  yield* sys.log("  cat <path>                  - print file contents");
  yield* sys.log("  echo-file <path> <text>     - write text to a file");
  yield* sys.log("  rm <path>                   - remove a file");
  yield* sys.log("  kill <pid> [SIGNAL]         - terminate a process");
  yield* sys.log("  help                        - this help");
  yield* sys.log("You can chain commands with ';', e.g.: ps; ls; netstat");
  yield* sys.exit(0);
}

// Shell process with multi-command support
export function* shellProcess(sys) {
  const SHELL_PORT = 9999;
  yield* sys.listen(SHELL_PORT);
  yield* sys.log(`Shell ready on port ${SHELL_PORT}`);

  while (true) {
    const msg = yield* sys.recvFromPort(SHELL_PORT);
    if (!msg) continue;

    const { fromPid, payload } = msg;
    const line = String(payload.command || "").trim();
    if (!line) {
      yield* sys.send(fromPid, {
        type: "SHELL_RESULT",
        output: "",
      });
      continue;
    }

    yield* sys.log(`Shell client ${fromPid}: comando "${line}"`);

    const parts = line
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const outputs = [];

    for (const part of parts) {
      const [cmd, ...args] = part.split(/\s+/);
      if (!cmd) continue;

      switch (cmd) {
        case "echo-client": {
          const [portStr, ...msgParts] = args;
          const port = Number(portStr || 8080);
          const text = msgParts.join(" ") || "hello";
          const pid = yield* sys.spawn((s) => echoClient(s, port, text), {
            name: "echo-client",
            priority: 1,
          });
          outputs.push(`Started echo-client (pid=${pid})`);
          break;
        }

        case "echo-server": {
          const [portStr] = args;
          const port = Number(portStr || 8080);
          const pid = yield* sys.spawn((s) => echoServer(s, port), {
            name: "echo-server",
            priority: 2,
          });
          outputs.push(`Started echo-server (pid=${pid})`);
          break;
        }

        case "ps": {
          const pid = yield* sys.spawn(psProgram, {
            name: "ps",
            priority: 1,
          });
          outputs.push(`Started ps (pid=${pid})`);
          break;
        }

        case "ls": {
          const pid = yield* sys.spawn(lsProgram, {
            name: "ls",
            priority: 1,
          });
          outputs.push(`Started ls (pid=${pid})`);
          break;
        }

        case "netstat": {
          const pid = yield* sys.spawn(netstatProgram, {
            name: "netstat",
            priority: 1,
          });
          outputs.push(`Started netstat (pid=${pid})`);
          break;
        }

        case "cat": {
          const [path] = args;
          const pid = yield* sys.spawn((s) => catProgram(s, path), {
            name: "cat",
            priority: 1,
          });
          outputs.push(`Started cat (pid=${pid})`);
          break;
        }

        case "echo-file": {
          const [path, ...textParts] = args;
          const pid = yield* sys.spawn(
            (s) => echoFileProgram(s, path, ...textParts),
            { name: "echo-file", priority: 1 }
          );
          outputs.push(`Started echo-file (pid=${pid})`);
          break;
        }

        case "rm": {
          const [path] = args;
          const pid = yield* sys.spawn((s) => rmProgram(s, path), {
            name: "rm",
            priority: 1,
          });
          outputs.push(`Started rm (pid=${pid})`);
          break;
        }

        case "kill": {
          const [pidStr, signal = "TERM"] = args;
          const targetPid = Number(pidStr);
          const pid = yield* sys.spawn(
            (s) => killProgram(s, targetPid, signal),
            { name: "kill", priority: 2 }
          );
          outputs.push(`Started kill (pid=${pid})`);
          break;
        }

        case "help": {
          const pid = yield* sys.spawn(helpProgram, {
            name: "help",
            priority: 1,
          });
          outputs.push(`Started help (pid=${pid})`);
          break;
        }

        default: {
          outputs.push(`Command not found: ${cmd}`);
          break;
        }
      }
    }

    const finalOut = outputs.join("\n");
    yield* sys.send(fromPid, {
      type: "SHELL_RESULT",
      output: finalOut,
    });
  }
}

// (fine kernel.js)
