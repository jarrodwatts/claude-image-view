#!/usr/bin/env node
'use strict'
// claude-pictures: runs Claude Code inside Windows Terminal with real picture previews.
//
// Claude Code is started under the newer Windows pseudo-console (the one VS Code ships), which
// passes its picture codes through. Everything it prints goes through the translator, which turns
// those codes into Sixel pictures Windows Terminal can draw. Keys and mouse go straight back in.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { StringDecoder } = require('string_decoder')
const koffi = require('koffi')
const pty = require('node-pty')
const { Translator } = require('./translate.cjs')

const ESC = '\x1b'
const STD_INPUT_HANDLE = -10
const STD_OUTPUT_HANDLE = -11
const ENABLE_WINDOW_INPUT = 0x0008
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200
const ENABLE_PROCESSED_OUTPUT = 0x0001
const ENABLE_WRAP_AT_EOL_OUTPUT = 0x0002
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
const DISABLE_NEWLINE_AUTO_RETURN = 0x0008
const UTF8 = 65001
const FLUSH_MS = 10
const RESIZE_POLL_MS = 150

// Every run writes a short log (what pictures came in, what was drawn) so problems can be read later.
const logFile = process.env.CLAUDE_PICTURES_LOG || path.join(__dirname, 'last.log')
try {
  fs.writeFileSync(logFile, '')
} catch {}
const log = line => {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

const kernel32 = koffi.load('kernel32.dll')
const GetStdHandle = kernel32.func('void* __stdcall GetStdHandle(int32_t)')
const GetConsoleMode = kernel32.func('bool __stdcall GetConsoleMode(void*, _Out_ uint32_t*)')
const SetConsoleMode = kernel32.func('bool __stdcall SetConsoleMode(void*, uint32_t)')
const GetConsoleCP = kernel32.func('uint32_t __stdcall GetConsoleCP()')
const SetConsoleCP = kernel32.func('bool __stdcall SetConsoleCP(uint32_t)')
const GetConsoleOutputCP = kernel32.func('uint32_t __stdcall GetConsoleOutputCP()')
const SetConsoleOutputCP = kernel32.func('bool __stdcall SetConsoleOutputCP(uint32_t)')
const ScreenBufferInfo = koffi.struct('CONSOLE_SCREEN_BUFFER_INFO', {
  sizeX: 'int16', sizeY: 'int16', cursorX: 'int16', cursorY: 'int16', attributes: 'uint16',
  left: 'int16', top: 'int16', right: 'int16', bottom: 'int16', maxX: 'int16', maxY: 'int16',
})
const GetConsoleScreenBufferInfo = kernel32.func('bool __stdcall GetConsoleScreenBufferInfo(void*, _Out_ CONSOLE_SCREEN_BUFFER_INFO*)')
const InputRecord = koffi.struct('INPUT_RECORD', {
  eventType: 'uint16', padding: 'uint16', keyDown: 'int32', repeatCount: 'uint16', virtualKeyCode: 'uint16',
  virtualScanCode: 'uint16', unicodeChar: 'uint16', controlKeyState: 'uint32',
})
const WriteConsoleInputW = kernel32.func('bool __stdcall WriteConsoleInputW(void*, INPUT_RECORD*, uint32_t, _Out_ uint32_t*)')

/** Feeds the console one space so a read waiting on it returns and the process can exit. */
function unblockInput(handle) {
  const record = { eventType: 1, padding: 0, keyDown: 1, repeatCount: 1, virtualKeyCode: 0x20, virtualScanCode: 0, unicodeChar: 0x20, controlKeyState: 0 }
  WriteConsoleInputW(handle, [record], 1, [0])
}

/** True for a `claude.cmd` that is this tool's own launcher (it would start us again). */
function isOwnLauncher(file) {
  try {
    return /claude-pictures/i.test(fs.readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

/**
 * How to start the Claude Code found at `file`, as `{ file, args }` for a spawn:
 *   - `claude.exe` (the native installer) runs as it is;
 *   - a `.js` entry (npm's `cli.js`) runs under this same Node;
 *   - an npm `claude.cmd` runs through the `cli.js` next to it when that exists, which keeps the
 *     arguments exactly as typed, and otherwise as a batch file.
 */
function launch(file, args) {
  const lower = file.toLowerCase()
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return { file: process.execPath, args: [file, ...args], batch: false }
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const cli = path.join(path.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    if (fs.existsSync(cli)) return { file: process.execPath, args: [cli, ...args], batch: false }
    return { file, args, batch: true }
  }
  return { file, args, batch: false }
}

/**
 * Finds Claude Code: `CLAUDE_PICTURES_CLAUDE` if set, else `claude.exe` on the PATH or in the
 * native installer's folder, else an npm `claude.cmd` on the PATH that is not our own launcher.
 */
function findClaude(args) {
  if (process.env.CLAUDE_PICTURES_CLAUDE) return launch(process.env.CLAUDE_PICTURES_CLAUDE, args)
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  dirs.push(path.join(os.homedir(), '.local', 'bin'))
  for (const dir of dirs) {
    const exe = path.join(dir, 'claude.exe')
    if (fs.existsSync(exe)) return launch(exe, args)
  }
  for (const dir of dirs) {
    for (const name of ['claude.cmd', 'claude.bat']) {
      const cmd = path.join(dir, name)
      if (fs.existsSync(cmd) && !isOwnLauncher(cmd)) return launch(cmd, args)
    }
  }
  return null
}

function windowSize(handle) {
  const info = {}
  if (!GetConsoleScreenBufferInfo(handle, info)) return null
  return { cols: info.right - info.left + 1, rows: info.bottom - info.top + 1 }
}

function main() {
  const claude = findClaude(process.argv.slice(2))
  if (!claude) {
    process.stderr.write('claude-pictures: Claude Code was not found. Install it, or set CLAUDE_PICTURES_CLAUDE to its path.\n')
    process.exit(1)
  }
  const inHandle = GetStdHandle(STD_INPUT_HANDLE)
  const outHandle = GetStdHandle(STD_OUTPUT_HANDLE)
  const inMode = [0]
  const outMode = [0]
  if (!GetConsoleMode(inHandle, inMode) || !GetConsoleMode(outHandle, outMode)) {
    // Not an interactive terminal (a script, a pipe, another program): run Claude as it is.
    const quote = arg => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)
    const result = claude.batch
      ? require('child_process').spawnSync([claude.file, ...claude.args].map(quote).join(' '), { stdio: 'inherit', shell: true })
      : require('child_process').spawnSync(claude.file, claude.args, { stdio: 'inherit' })
    process.exit(result.status ?? 1)
  }
  const oldInputCP = GetConsoleCP()
  const oldOutputCP = GetConsoleOutputCP()
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    SetConsoleMode(inHandle, inMode[0])
    SetConsoleMode(outHandle, outMode[0])
    SetConsoleCP(oldInputCP)
    SetConsoleOutputCP(oldOutputCP)
  }
  process.on('exit', restore)
  process.on('uncaughtException', error => {
    restore()
    process.stderr.write(`claude-pictures: ${error.stack}\n`)
    process.exit(1)
  })

  SetConsoleCP(UTF8)
  SetConsoleOutputCP(UTF8)
  SetConsoleMode(inHandle, ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_WINDOW_INPUT)
  SetConsoleMode(outHandle, ENABLE_PROCESSED_OUTPUT | ENABLE_WRAP_AT_EOL_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN)

  const outFd = fs.openSync('\\\\.\\CONOUT$', 'w')
  const inFd = fs.openSync('\\\\.\\CONIN$', 'r')
  const write = text => {
    if (text) fs.writeSync(outFd, text)
  }

  const size = windowSize(outHandle) || { cols: 120, rows: 30 }
  const translator = new Translator({ log })
  const child = pty.spawn(claude.file, claude.args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: process.cwd(),
    useConptyDll: true,
    env: { ...process.env, CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1', COLORTERM: 'truecolor', CLAUDE_PICTURES: '1' },
  })
  log(`started ${claude.file} ${claude.args.join(' ')} (pid ${child.pid}) at ${size.cols}x${size.rows}`)

  // Claude asks the terminal for its cell size too; its answers are passed on only while it has
  // a question outstanding, and ours (asked at start and after every resize) are swallowed.
  const outstanding = { 6: 0, 4: 0, 8: 0 }
  // Asked three ways: the cell size directly, and the screen size in pixels and in cells, from
  // which the cell size follows when a terminal only answers those.
  const askCellSize = () => write(`${ESC}[16t${ESC}[14t${ESC}[18t`)
  const screen = { pixels: null, cells: null }
  const sizeReport = (kind, a, b) => {
    if (kind === 6) translator.setCellSize(b, a)
    if (kind === 4) screen.pixels = { height: a, width: b }
    if (kind === 8) screen.cells = { rows: a, cols: b }
    if (kind !== 6 && screen.pixels && screen.cells && screen.cells.cols > 0 && screen.cells.rows > 0) {
      translator.setCellSize(Math.floor(screen.pixels.width / screen.cells.cols), Math.floor(screen.pixels.height / screen.cells.rows))
    }
  }

  let flushTimer
  child.onData(data => {
    for (const m of data.matchAll(/\x1b\[1([468])t/g)) outstanding[{ 6: 6, 4: 4, 8: 8 }[m[1]]]++
    // Which mouse reporting Claude asks the terminal for, so a dead click can be diagnosed later.
    for (const m of data.matchAll(/\x1b\[\?(100[0-6]|1015|1016)[hl]/g)) log(`mouse mode ${m[0].slice(2)}`)
    write(translator.push(data))
    clearTimeout(flushTimer)
    flushTimer = setTimeout(() => write(translator.flush()), FLUSH_MS)
  })

  // A left click on a picture (or the open label under it) opens the picture in the default viewer.
  // Hidden test runs set IMAGE_VIEW_CLICK_LOG and get a note in that file instead of a window.
  const openPicture = image => {
    try {
      const file = translator.pictureFile(image)
      if (process.env.IMAGE_VIEW_CLICK_LOG) {
        fs.appendFileSync(process.env.IMAGE_VIEW_CLICK_LOG, `clicked ${file}\n`)
        log(`click noted for ${file}`)
        return
      }
      require('child_process').spawn('explorer.exe', [file], { detached: true, stdio: 'ignore' }).unref()
      log(`opened ${file}`)
    } catch (error) {
      log(`could not open picture: ${error.message}`)
    }
  }

  // Keys and mouse from the terminal, minus the size and cursor reports that answer our own
  // questions, and minus clicks on a picture, which open it here.
  const inDecoder = new StringDecoder('utf8')
  let inCarry = ''
  let inTimer
  let swallowRelease = false
  const buffer = Buffer.alloc(65536)
  const forward = (text, final) => {
    let out = ''
    let i = 0
    while (i < text.length) {
      const at = text.indexOf(`${ESC}[`, i)
      if (at < 0) {
        out += text.slice(i)
        break
      }
      out += text.slice(i, at)
      const ahead = text.slice(at, at + 24)
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(ahead)
      if (mouse) {
        const [whole, button, x, y, kind] = mouse
        i = at + whole.length
        if (button === '0' && kind === 'M') {
          const image = translator.imageAt(Number(x), Number(y))
          if (image) {
            openPicture(image)
            swallowRelease = true
            continue
          }
        } else if (button === '0' && swallowRelease) {
          swallowRelease = false
          continue
        }
        out += whole
        continue
      }
      const cursor = /^\x1b\[(\d+);(\d+)R/.exec(ahead)
      if (cursor) {
        i = at + cursor[0].length
        if (!translator.answerPosition(Number(cursor[1]), Number(cursor[2]))) out += cursor[0]
        continue
      }
      const m = /^\x1b\[([468]);(\d+);(\d+)t/.exec(ahead)
      if (m) {
        const kind = Number(m[1])
        sizeReport(kind, Number(m[2]), Number(m[3]))
        if (outstanding[kind] > 0) {
          outstanding[kind]--
          out += m[0]
        }
        i = at + m[0].length
      } else if (text.length - at < 24 && !final && !/[\x40-\x7e]/.test(text.slice(at + 2))) {
        inCarry = text.slice(at)
        break
      } else {
        out += text.slice(at, at + 2)
        i = at + 2
      }
    }
    if (out) child.write(out)
  }
  let exiting = false
  const readInput = () => {
    fs.read(inFd, buffer, 0, buffer.length, null, (error, count) => {
      if (exiting) return
      if (error) {
        log(`input read failed: ${error.message}`)
        return
      }
      const text = inCarry + inDecoder.write(buffer.subarray(0, count))
      if (process.env.CLAUDE_PICTURES_DEBUG_INPUT === '1') log(`input ${JSON.stringify(text)}`)
      inCarry = ''
      clearTimeout(inTimer)
      forward(text, false)
      if (inCarry) inTimer = setTimeout(() => forward(inCarry, true), FLUSH_MS)
      readInput()
    })
  }
  readInput()

  let last = size
  setInterval(() => {
    const now = windowSize(outHandle)
    if (now && (now.cols !== last.cols || now.rows !== last.rows)) {
      last = now
      child.resize(now.cols, now.rows)
      log(`resized to ${now.cols}x${now.rows}`)
      askCellSize()
    }
  }, RESIZE_POLL_MS).unref()
  askCellSize()

  child.onExit(({ exitCode }) => {
    log(`claude exited with ${exitCode}`)
    exiting = true
    write(translator.flush())
    restore()
    unblockInput(inHandle)
    setImmediate(() => {
      log('exiting')
      process.exit(exitCode)
    })
  })
}

if (require.main === module) main()

module.exports = { findClaude, launch, isOwnLauncher }
