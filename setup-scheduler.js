#!/usr/bin/env node

/**
 * Register (or update) a Windows Task Scheduler task for Daily AI Tracker.
 *
 * Creates a task named "DailyTrackerAI" that runs catch-up mode daily at 11:30 AM.
 * Idempotent — re-running overwrites the existing task.
 *
 * Usage:
 *   node setup-scheduler.js            Register the scheduled task
 *   node setup-scheduler.js --remove   Remove the scheduled task
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./src/config');

const TASK_NAME = 'DailyTrackerAI';
const SCHEDULE_TIME = '11:30';

/**
 * Build the schtasks command components.
 * Exported for testing without executing.
 */
function buildSchedulerConfig() {
  const nodePath = process.execPath;
  const projectDir = __dirname;
  const indexerScript = path.join(projectDir, 'index-conversations.js');
  const trackerScript = path.join(projectDir, 'tracker.js');
  const logFile = path.join(config.output.directory, 'tracker.log');
  const batchFile = path.join(projectDir, 'run-tracker.bat');

  return {
    taskName: TASK_NAME,
    scheduleTime: SCHEDULE_TIME,
    nodePath,
    projectDir,
    indexerScript,
    trackerScript,
    logFile,
    batchFile,
  };
}

/**
 * Build the batch file content that the scheduled task will execute.
 * A wrapper .bat avoids all quoting hell with schtasks /TR and spaces in paths.
 */
function buildBatchContent(cfg) {
  const nodeDir = path.dirname(cfg.nodePath);
  return [
    '@echo off',
    `cd /d "${cfg.projectDir}"`,
    `set PATH=%NVM_SYMLINK%;${nodeDir};%APPDATA%\\npm;%PATH%`,
    `"${cfg.nodePath}" "${cfg.indexerScript}" >> "${cfg.logFile}" 2>&1`,
    'if errorlevel 1 exit /b %errorlevel%',
    `"${cfg.nodePath}" "${cfg.trackerScript}" >> "${cfg.logFile}" 2>&1`,
  ].join('\r\n') + '\r\n';
}

/**
 * Build the command line passed to schtasks /TR.
 * Use cmd.exe explicitly so Task Scheduler stores the batch path in Arguments
 * rather than splitting the path at spaces.
 */
function buildTaskRunCommand(cfg) {
  return `cmd.exe /d /c ""${cfg.batchFile}""`;
}

/**
 * Build schtasks /Create argument array.
 */
function buildCreateArgs(cfg) {
  return [
    '/Create',
    '/TN', cfg.taskName,
    '/SC', 'DAILY',
    '/ST', cfg.scheduleTime,
    '/TR', buildTaskRunCommand(cfg),
    '/F',
  ];
}

/**
 * Build the full schtasks /Create command string.
 */
function buildCreateCommand(cfg) {
  return `schtasks ${buildCreateArgs(cfg).map(arg => /\s/.test(arg) ? `"${arg}"` : arg).join(' ')}`;
}

/**
 * Build schtasks /Delete argument array.
 */
function buildDeleteArgs() {
  return ['/Delete', '/TN', TASK_NAME, '/F'];
}

/**
 * Build the schtasks /Delete command string.
 */
function buildDeleteCommand() {
  return `schtasks ${buildDeleteArgs().map(arg => /\s/.test(arg) ? `"${arg}"` : arg).join(' ')}`;
}

/**
 * Build schtasks /Query argument array.
 */
function buildQueryArgs() {
  return ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'];
}

/**
 * Build the schtasks /Query command string.
 */
function buildQueryCommand() {
  return `schtasks ${buildQueryArgs().map(arg => /\s/.test(arg) ? `"${arg}"` : arg).join(' ')}`;
}

// ── Main ──────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isRemove = args.includes('--remove');

  if (isRemove) {
    console.log(`[scheduler] Removing task "${TASK_NAME}"...`);
    const cmd = buildDeleteCommand();
    console.log(`[scheduler] Command: ${cmd}`);

    try {
      execFileSync('schtasks', buildDeleteArgs(), { stdio: 'pipe' });
      console.log(`[scheduler] ✓ Task "${TASK_NAME}" removed.`);
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
      console.error(`[scheduler] ✗ Failed to remove task: ${stderr}`);
      process.exit(1);
    }
    return;
  }

  // Create/update
  console.log(`[scheduler] Setting up task "${TASK_NAME}" — daily at ${SCHEDULE_TIME}...`);
  console.log();

  const cfg = buildSchedulerConfig();

  // The batch file appends to a log in the output folder, so that folder must exist.
  fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true });

  // Write the wrapper batch file
  const batchContent = buildBatchContent(cfg);
  fs.writeFileSync(cfg.batchFile, batchContent);
  console.log(`[scheduler] Wrote:      ${cfg.batchFile}`);
  console.log(`[scheduler] Node:       ${cfg.nodePath}`);
  console.log(`[scheduler] Indexer:    ${cfg.indexerScript}`);
  console.log(`[scheduler] Script:     ${cfg.trackerScript}`);
  console.log(`[scheduler] Log file:   ${cfg.logFile}`);
  console.log(`[scheduler] Schedule:   Daily at ${cfg.scheduleTime}`);
  console.log();

  const cmd = buildCreateCommand(cfg);
  console.log(`[scheduler] Command: ${cmd}`);
  console.log();

  try {
    const output = execFileSync('schtasks', buildCreateArgs(cfg), { stdio: 'pipe' });
    const stdout = output.toString().trim();
    if (stdout) console.log(stdout);
    console.log(`[scheduler] ✓ Task "${TASK_NAME}" registered successfully.`);
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
    console.error(`[scheduler] ✗ Failed to register task: ${stderr}`);
    process.exit(1);
  }

  // Verify
  console.log();
  console.log(`[scheduler] Verifying...`);
  try {
    const queryOut = execFileSync('schtasks', buildQueryArgs(), { stdio: 'pipe' });
    console.log(queryOut.toString().trim());
    console.log();
    console.log(`[scheduler] ✓ Task verified and ready.`);
  } catch (err) {
    console.warn(`[scheduler] Could not verify task — it may still be registered correctly.`);
  }
}

module.exports = {
  buildSchedulerConfig,
  buildCreateArgs,
  buildCreateCommand,
  buildBatchContent,
  buildTaskRunCommand,
  buildDeleteArgs,
  buildDeleteCommand,
  buildQueryArgs,
  buildQueryCommand,
  TASK_NAME,
  SCHEDULE_TIME,
};

if (require.main === module) {
  main();
}
