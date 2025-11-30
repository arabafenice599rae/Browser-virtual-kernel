// kernel.js

export const ProcessState = Object.freeze({
  READY: "READY",
  RUNNING: "RUNNING",
  BLOCKED: "BLOCKED",
  TERMINATED: "TERMINATED",
});

let GLOBAL_NEXT_PID = 1;

export class Kernel {
  constructor({ tickMs = 50 } = {}) {
    this.tickMs = tickMs;
    this.time = 0; // logical time
    this.processes = [];
    this.mailboxes = new Map(); // pid -> messages
    this.vfs = new Map(); // path -> string
    this.programs = new Map(); // name -> generator factory

    this.ports = new Map(); // portKey (string) -> { ownerPid, queue: [] }
    this.logs = [];

    this.vfs.set("/etc/motd", "Benvenuto nel mini-kernel in JS!\n");
  }

  // ---------- Program registration ----------

  registerProgram(name, generatorFactory) {
    this.programs.set(name, generatorFactory);
  }

  // ---------- Process management ----------

  spawn(programFactory, { name = "proc", priority = 1, args = [] } = {}) {
    const pid = GLOBAL_NEXT_PID++;
    const sys = this._createSyscalls(pid);
    const iterator = programFactory(sys, ...(args || []));
    const now = Date.now();

    const pcb = {
      pid,
      name,
      priority,
      iterator,
      state: ProcessState.READY,
      wakeTime: null,
      blockReason: null, // "sleep", "recv", "recv_port"
      waitFrom: null,
      waitPort: null,
      waitTimeoutAt: null,
      lastSyscallResult: undefined,
      exitCode: null,
      fdTable: new Map(),
      nextFd: 3,
      heap: {},
      spawnTime: now,
    };

    // preallocate stdin/out/err
    pcb.fdTable.set(0, { type: "stdin" });
    pcb.fdTable.set(1, { type: "stdout" });
    pcb.fdTable.set(2, { type: "stderr" });

    this.processes.push(pcb);
    this.mailboxes.set(pid, []);
    return pid;
  }

  _createSyscalls(pid) {
    return {
      // time / scheduling
      sleep: (ms) => ({ type: "SLEEP", ms }),

      // IPC pid-to-pid
      recv: (from = null) => ({ type: "RECV", from }),
      send: (to, message) => ({ type: "SEND", to, message }),

      // info / log
      getPid: () => ({ type: "GETPID" }),
      log: (msg) => ({ type: "LOG", msg }),

      // VFS
      open: (path, mode = "r") => ({ type: "OPEN", path, mode }),
      read: (fd, n = null) => ({ type: "READ", fd, n }),
      write: (fd, data) => ({ type: "WRITE", fd, data }),
      close: (fd) => ({ type: "CLOSE", fd }),

      // process control
      exec: (programName, args = []) => ({
        type: "EXEC",
        programName,
        args,
      }),
      exit: (code = 0) => ({ type: "EXIT", code }),

      // per-process heap
      heapSet: (key, value) => ({ type: "HEAP_SET", key, value }),
      heapGet: (key) => ({ type: "HEAP_GET", key }),

      // networking over ports
      listen: (port) => ({ type: "LISTEN", port }),
      unlisten: (port) => ({ type: "UNLISTEN", port }),
      sendToPort: (port, payload) => ({ type: "SEND_PORT", port, payload }),
      recvFromPort: (port, timeoutMs = null) => ({
        type: "RECV_PORT",
        port,
        timeoutMs,
      }),

      // spawn another program by name
      spawn: (programName, args = [], priority = 1) => ({
        type: "SPAWN",
        programName,
        args,
        priority,
      }),

      // kernel info (for ps/ls/netstat)
      kernelInfo: (kind) => ({ type: "KINFO", kind }),
    };
  }

  cleanupTerminated() {
    const deadPids = new Set(
      this.processes
        .filter((p) => p.state === ProcessState.TERMINATED)
        .map((p) => p.pid)
    );

    this.processes = this.processes.filter(
      (p) => p.state !== ProcessState.TERMINATED
    );

    for (const pid of deadPids) {
      this.mailboxes.delete(pid);
      for (const [key, info] of this.ports.entries()) {
        if (info.ownerPid === pid) {
          this.ports.delete(key);
        }
      }
    }
  }

  // ---------- Kernel tick ----------

  tick() {
    this.time += this.tickMs;

    // unblock sleepers and timed-out port receivers
    for (const pcb of this.processes) {
      if (
        pcb.state === ProcessState.BLOCKED &&
        pcb.blockReason === "sleep" &&
        pcb.wakeTime !== null &&
        pcb.wakeTime <= this.time
      ) {
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.wakeTime = null;
      }

      if (
        pcb.state === ProcessState.BLOCKED &&
        pcb.blockReason === "recv_port" &&
        pcb.waitTimeoutAt !== null &&
        pcb.waitTimeoutAt <= this.time
      ) {
        pcb.state = ProcessState.READY;
        pcb.blockReason = null;
        pcb.waitPort = null;
        pcb.waitTimeoutAt = null;
        pcb.lastSyscallResult = null; // timeout
      }
    }

    const ready = this.processes.filter(
      (p) => p.state === ProcessState.READY
    );
    if (ready.length === 0) return;

    ready.sort((a, b) => b.priority - a.priority);
    const pcb = ready[0];

    pcb.state = ProcessState.RUNNING;

    const { value: syscallReq, done } = pcb.iterator.next(
      pcb.lastSyscallResult
    );

    if (done) {
      pcb.state = ProcessState.TERMINATED;
      return;
    }

    if (syscallReq && typeof syscallReq === "object" && syscallReq.type) {
      pcb.lastSyscallResult = this._handleSyscall(pcb, syscallReq);
    } else {
      pcb.lastSyscallResult = undefined;
      pcb.state = ProcessState.READY;
    }
  }

  // ---------- Helpers ----------

  _allocFd(pcb, meta) {
    const fd = pcb.nextFd++;
    pcb.fdTable.set(fd, meta);
    return fd;
  }

  _normalizePortKey(port) {
    return String(port);
  }

  _handleSyscall(pcb, req) {
    switch (req.type) {
      // time
      case "SLEEP": {
        pcb.state = ProcessState.BLOCKED;
        pcb.blockReason = "sleep";
        pcb.wakeTime = this.time + (req.ms ?? 0);
        return null;
      }

      // logging / info
      case "LOG": {
        const entry = { time: this.time, pid: pcb.pid, msg: req.msg };
        this.logs.push(entry);
        console.log(`[PID ${pcb.pid}]`, req.msg);
        pcb.state = ProcessState.READY;
        return null;
      }

      case "GETPID": {
        pcb.state = ProcessState.READY;
        return pcb.pid;
      }

      // IPC pid-to-pid
      case "SEND": {
        const { to, message } = req;
        if (!this.mailboxes.has(to)) {
          this.mailboxes.set(to, []);
        }
        const msg = { from: pcb.pid, payload: message, time: this.time };
        this.mailboxes.get(to).push(msg);

        for (const other of this.processes) {
          if (
            other.pid === to &&
            other.state === ProcessState.BLOCKED &&
            other.blockReason === "recv"
          ) {
            const delivered = this._tryDeliverMessage(other);
            if (delivered !== null) {
              other.lastSyscallResult = delivered;
              other.state = ProcessState.READY;
              other.blockReason = null;
              other.waitFrom = null;
            }
          }
        }

        pcb.state = ProcessState.READY;
        return true;
      }

      case "RECV": {
        pcb.blockReason = "recv";
        pcb.waitFrom = req.from ?? null;

        const maybeMsg = this._tryDeliverMessage(pcb);
        if (maybeMsg !== null) {
          pcb.state = ProcessState.READY;
          pcb.blockReason = null;
          pcb.waitFrom = null;
          return maybeMsg;
        } else {
          pcb.state = ProcessState.BLOCKED;
          return null;
        }
      }

      // VFS
      case "OPEN": {
        const path = req.path;
        const mode = req.mode || "r";
        let content = this.vfs.get(path);

        if (mode === "r") {
          if (content === undefined) {
            pcb.state = ProcessState.READY;
            return -1;
          }
          const fd = this._allocFd(pcb, {
            type: "file",
            path,
            pos: 0,
            mode,
          });
          pcb.state = ProcessState.READY;
          return fd;
        }

        if (mode === "w") {
          content = "";
          this.vfs.set(path, content);
          const fd = this._allocFd(pcb, {
            type: "file",
            path,
            pos: 0,
            mode,
          });
          pcb.state = ProcessState.READY;
          return fd;
        }

        if (mode === "a") {
          if (content === undefined) content = "";
          this.vfs.set(path, content);
          const fd = this._allocFd(pcb, {
            type: "file",
            path,
            pos: content.length,
            mode,
          });
          pcb.state = ProcessState.READY;
          return fd;
        }

        pcb.state = ProcessState.READY;
        return -1;
      }

      case "READ": {
        const fd = req.fd;
        const n = req.n ?? null;
        const entry = pcb.fdTable.get(fd);
        if (!entry || entry.type !== "file") {
          pcb.state = ProcessState.READY;
          return null;
        }
        const content = this.vfs.get(entry.path) ?? "";
        const start = entry.pos;
        const end = n == null ? content.length : start + n;
        if (start >= content.length) {
          pcb.state = ProcessState.READY;
          return "";
        }
        const chunk = content.slice(start, end);
        entry.pos = end;
        pcb.state = ProcessState.READY;
        return chunk;
      }

      case "WRITE": {
        const fd = req.fd;
        const data = req.data ?? "";

        if (fd === 1) {
          console.log(`[PID ${pcb.pid} STDOUT]`, String(data));
          pcb.state = ProcessState.READY;
          return String(data).length;
        }
        if (fd === 2) {
          console.error(`[PID ${pcb.pid} STDERR]`, String(data));
          pcb.state = ProcessState.READY;
          return String(data).length;
        }

        const entry = pcb.fdTable.get(fd);
        if (!entry || entry.type !== "file") {
          pcb.state = ProcessState.READY;
          return -1;
        }

        const text = String(data);
        let content = this.vfs.get(entry.path) ?? "";
        const start = entry.pos;

        if (start >= content.length) {
          content = content + text;
        } else {
          const before = content.slice(0, start);
          const after = content.slice(start + text.length);
          content = before + text + after;
        }

        entry.pos = start + text.length;
        this.vfs.set(entry.path, content);
        pcb.state = ProcessState.READY;
        return text.length;
      }

      case "CLOSE": {
        pcb.fdTable.delete(req.fd);
        pcb.state = ProcessState.READY;
        return 0;
      }

      // process control
      case "EXEC": {
        const { programName, args } = req;
        const prog = this.programs.get(programName);
        if (!prog) {
          pcb.state = ProcessState.READY;
          return -1;
        }
        const sys = this._createSyscalls(pcb.pid);
        pcb.iterator = prog(sys, ...(args || []));
        pcb.state = ProcessState.READY;
        pcb.lastSyscallResult = 0;
        return 0;
      }

      case "EXIT": {
        pcb.exitCode = req.code ?? 0;
        pcb.state = ProcessState.TERMINATED;
        return pcb.exitCode;
      }

      case "HEAP_SET": {
        pcb.heap[req.key] = req.value;
        pcb.state = ProcessState.READY;
        return true;
      }

      case "HEAP_GET": {
        const val = pcb.heap[req.key];
        pcb.state = ProcessState.READY;
        return val;
      }

      // networking over ports
      case "LISTEN": {
        const portKey = this._normalizePortKey(req.port);
        if (this.ports.has(portKey)) {
          pcb.state = ProcessState.READY;
          return false;
        }
        this.ports.set(portKey, {
          ownerPid: pcb.pid,
          queue: [],
        });
        pcb.state = ProcessState.READY;
        return true;
      }

      case "UNLISTEN": {
        const portKey = this._normalizePortKey(req.port);
        const entry = this.ports.get(portKey);
        if (entry && entry.ownerPid === pcb.pid) {
          this.ports.delete(portKey);
          pcb.state = ProcessState.READY;
          return true;
        }
        pcb.state = ProcessState.READY;
        return false;
      }

      case "SEND_PORT": {
        const portKey = this._normalizePortKey(req.port);
        const entry = this.ports.get(portKey);
        if (!entry) {
          pcb.state = ProcessState.READY;
          return false;
        }
        entry.queue.push({
          fromPid: pcb.pid,
          payload: req.payload,
          time: this.time,
        });

        for (const other of this.processes) {
          if (
            other.pid === entry.ownerPid &&
            other.state === ProcessState.BLOCKED &&
            other.blockReason === "recv_port" &&
            other.waitPort === portKey
          ) {
            const msg = entry.queue.shift();
            if (msg) {
              other.lastSyscallResult = msg;
              other.state = ProcessState.READY;
              other.blockReason = null;
              other.waitPort = null;
              other.waitTimeoutAt = null;
            }
          }
        }

        pcb.state = ProcessState.READY;
        return true;
      }

      case "RECV_PORT": {
        const portKey = this._normalizePortKey(req.port);
        const timeoutMs = req.timeoutMs;
        const entry = this.ports.get(portKey);

        if (!entry || entry.ownerPid !== pcb.pid) {
          pcb.state = ProcessState.READY;
          return null;
        }

        if (entry.queue.length === 0) {
          pcb.state = ProcessState.BLOCKED;
          pcb.blockReason = "recv_port";
          pcb.waitPort = portKey;
          pcb.waitTimeoutAt =
            timeoutMs == null ? null : this.time + timeoutMs;
          return null;
        } else {
          const msg = entry.queue.shift();
          pcb.state = ProcessState.READY;
          return msg;
        }
      }

      // spawn from inside
      case "SPAWN": {
        const { programName, args, priority } = req;
        const prog = this.programs.get(programName);
        if (!prog) {
          pcb.state = ProcessState.READY;
          return -1;
        }
        const childPid = this.spawn(prog, {
          name: programName,
          priority: priority ?? 1,
          args,
        });
        pcb.state = ProcessState.READY;
        return childPid;
      }

      // kernel info
      case "KINFO": {
        switch (req.kind) {
          case "PS":
            pcb.state = ProcessState.READY;
            return this.getProcessTable();
          case "PORTS":
            pcb.state = ProcessState.READY;
            return this.getPortsTable();
          case "VFS":
            pcb.state = ProcessState.READY;
            return this.listFiles();
          default:
            pcb.state = ProcessState.READY;
            return null;
        }
      }

      default: {
        console.warn("Unknown syscall:", req);
        pcb.state = ProcessState.READY;
        return null;
      }
    }
  }

  _tryDeliverMessage(pcb) {
    const queue = this.mailboxes.get(pcb.pid) || [];
    if (queue.length === 0) return null;

    if (pcb.waitFrom == null) {
      return queue.shift();
    } else {
      const idx = queue.findIndex((m) => m.from === pcb.waitFrom);
      if (idx === -1) return null;
      const [msg] = queue.splice(idx, 1);
      return msg;
    }
  }

  // ---------- UI helpers ----------

  getProcessTable() {
    return this.processes.map((p) => ({
      pid: p.pid,
      name: p.name,
      priority: p.priority,
      state: p.state,
      blockReason: p.blockReason,
      wakeTime: p.wakeTime,
      exitCode: p.exitCode,
      lastSyscallResult: p.lastSyscallResult,
      spawnTime: p.spawnTime,
    }));
  }

  getPortsTable() {
    return Array.from(this.ports.entries()).map(([portKey, info]) => ({
      port: portKey,
      ownerPid: info.ownerPid,
      queueLength: info.queue.length,
    }));
  }

  listFiles() {
    return Array.from(this.vfs.entries()).map(([path, content]) => ({
      path,
      size: content.length,
      preview: content.slice(0, 80),
    }));
  }

  getLogs(limit = 200) {
    if (this.logs.length <= limit) return this.logs.slice();
    return this.logs.slice(this.logs.length - limit);
  }
}

// ----------------------------------------------------------
// Programs: echo server/client, shell, ps, ls, netstat
// ----------------------------------------------------------

export function* echoServer(sys, port) {
  const ok = yield sys.listen(port);
  if (!ok) {
    yield sys.log(`Echo: unable to listen on port ${port}`);
    yield sys.exit(1);
  }
  yield sys.log(`Echo server listening on port ${port}`);

  while (true) {
    const msg = yield sys.recvFromPort(port); // blocks
    if (!msg) continue;
    const { fromPid, payload } = msg;
    yield sys.log(
      `Echo server: from PID ${fromPid} -> ${JSON.stringify(payload)}`
    );
    yield sys.send(fromPid, {
      type: "ECHO_REPLY",
      port,
      payload,
    });
  }
}

export function* echoClient(sys, port, message) {
  const myPid = yield sys.getPid();
  yield sys.log(`Client ${myPid}: send to port ${port}: ${message}`);

  yield sys.sendToPort(port, { text: message, from: myPid });

  const reply = yield sys.recv();
  if (reply && reply.payload && reply.payload.type === "ECHO_REPLY") {
    yield sys.log(
      `Client ${myPid}: reply = ${JSON.stringify(reply.payload.payload)}`
    );
  } else {
    yield sys.log(`Client ${myPid}: no valid reply`);
  }
  yield sys.exit(0);
}

// Shell listening on port 9999: receives a line and spawn a program
export function* shellProcess(sys) {
  const PORT = 9999;
  const ok = yield sys.listen(PORT);
  if (!ok) {
    yield sys.log(`Shell: port ${PORT} already in use`);
    yield sys.exit(1);
  }
  yield sys.log(`Shell ready on port ${PORT}`);

  while (true) {
    const msg = yield sys.recvFromPort(PORT);
    if (!msg) continue;

    const { fromPid, payload } = msg;
    const line = String(payload?.command || "").trim();
    if (!line) continue;

    const parts = line.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    const childPid = yield sys.spawn(cmd, args, 1);

    if (childPid < 0) {
      yield sys.send(fromPid, {
        type: "SHELL_RESULT",
        ok: false,
        output: `Command not found: ${cmd}`,
      });
    } else {
      yield sys.send(fromPid, {
        type: "SHELL_RESULT",
        ok: true,
        output: `Started ${cmd} (pid=${childPid})`,
      });
    }
  }
}

// ps: print process table
export function* psProgram(sys) {
  const table = yield sys.kernelInfo("PS");
  yield sys.log("=== ps ===");
  for (const p of table) {
    yield sys.log(
      `pid=${p.pid} name=${p.name} prio=${p.priority} state=${p.state} block=${p.blockReason || "-"}`
    );
  }
  yield sys.exit(0);
}

// ls: print VFS
export function* lsProgram(sys) {
  const files = yield sys.kernelInfo("VFS");
  yield sys.log("=== ls (VFS) ===");
  for (const f of files) {
    yield sys.log(`${f.path} (${f.size} bytes)`);
  }
  yield sys.exit(0);
}

// netstat: print ports
export function* netstatProgram(sys) {
  const ports = yield sys.kernelInfo("PORTS");
  yield sys.log("=== netstat ===");
  for (const p of ports) {
    yield sys.log(
      `port=${p.port} ownerPid=${p.ownerPid} queue=${p.queueLength}`
    );
  }
  yield sys.exit(0);
}
