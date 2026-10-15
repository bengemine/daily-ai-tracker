const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  buildSchedulerConfig,
  buildCreateCommand,
  buildBatchContent,
  buildTaskRunCommand,
  buildDeleteCommand,
  buildQueryCommand,
  TASK_NAME,
  SCHEDULE_TIME,
} = require('../setup-scheduler');

describe('scheduler config', () => {
  it('task name is DailyTrackerAI', () => {
    assert.equal(TASK_NAME, 'DailyTrackerAI');
  });

  it('schedule time is 11:30', () => {
    assert.equal(SCHEDULE_TIME, '11:30');
  });
});

describe('buildSchedulerConfig', () => {
  const cfg = buildSchedulerConfig();

  it('uses current node executable path', () => {
    assert.equal(cfg.nodePath, process.execPath);
  });

  it('points tracker script to tracker.js in project dir', () => {
    assert.ok(cfg.trackerScript.endsWith('tracker.js'));
    assert.equal(path.dirname(cfg.trackerScript).toLowerCase(), cfg.projectDir.toLowerCase());
  });

  it('points indexer script to index-conversations.js in project dir', () => {
    assert.ok(cfg.indexerScript.endsWith('index-conversations.js'));
    assert.equal(path.dirname(cfg.indexerScript).toLowerCase(), cfg.projectDir.toLowerCase());
  });

  it('puts log file in output directory', () => {
    assert.ok(cfg.logFile.endsWith('tracker.log'));
    assert.ok(cfg.logFile.includes('ai-tracker'));
  });

  it('batch file is in project directory', () => {
    assert.ok(cfg.batchFile.endsWith('run-tracker.bat'));
    assert.equal(path.dirname(cfg.batchFile).toLowerCase(), cfg.projectDir.toLowerCase());
  });
});

describe('buildBatchContent', () => {
  const cfg = buildSchedulerConfig();
  const content = buildBatchContent(cfg);

  it('starts with @echo off', () => {
    assert.ok(content.startsWith('@echo off'));
  });

  it('changes to project directory', () => {
    assert.ok(content.includes(`cd /d "${cfg.projectDir}"`));
  });

  it('runs node with tracker.js', () => {
    assert.ok(content.includes(cfg.nodePath));
    assert.ok(content.includes(cfg.trackerScript));
  });

  it('provides Node and normal global CLI locations without forcing a stale Claude path', () => {
    assert.ok(!content.includes('set CLAUDE_CLI_PATH='));
    assert.ok(content.includes('set PATH='));
    assert.ok(content.includes('%NVM_SYMLINK%'));
    assert.ok(content.includes('%APPDATA%\\npm'));
  });

  it('runs the deterministic indexer before tracker and stops on failure', () => {
    const indexerAt = content.indexOf(cfg.indexerScript);
    const failureGuardAt = content.indexOf('if errorlevel 1 exit /b %errorlevel%');
    const trackerAt = content.indexOf(cfg.trackerScript);
    assert.ok(indexerAt >= 0);
    assert.ok(failureGuardAt > indexerAt);
    assert.ok(trackerAt > failureGuardAt);
  });

  it('redirects output to log file', () => {
    assert.ok(content.includes('>> '));
    assert.ok(content.includes(cfg.logFile));
    assert.ok(content.includes('2>&1'));
  });

  it('uses CRLF line endings (Windows)', () => {
    assert.ok(content.includes('\r\n'));
  });
});

describe('buildCreateCommand', () => {
  const cfg = buildSchedulerConfig();
  const cmd = buildCreateCommand(cfg);

  it('uses schtasks /Create', () => {
    assert.ok(cmd.startsWith('schtasks /Create'));
  });

  it('sets task name', () => {
    assert.ok(cmd.includes(`/TN ${TASK_NAME}`));
  });

  it('sets daily schedule', () => {
    assert.ok(cmd.includes('/SC DAILY'));
  });

  it('sets start time to 11:30', () => {
    assert.ok(cmd.includes('/ST 11:30'));
  });

  it('includes /F for force overwrite', () => {
    assert.ok(cmd.includes('/F'));
  });

  it('wraps execution through cmd.exe so batch paths with spaces work', () => {
    assert.ok(cmd.includes('/TR '));
    assert.ok(cmd.includes('cmd.exe /d /c'));
    assert.ok(cmd.includes('run-tracker.bat'));
  });
});

describe('buildTaskRunCommand', () => {
  const cfg = buildSchedulerConfig();
  const cmd = buildTaskRunCommand(cfg);

  it('uses cmd.exe explicitly', () => {
    assert.ok(cmd.startsWith('cmd.exe /d /c'));
  });

  it('double-quotes the batch path for Task Scheduler', () => {
    assert.ok(cmd.includes(`""${cfg.batchFile}""`));
  });
});

describe('buildDeleteCommand', () => {
  const cmd = buildDeleteCommand();

  it('uses schtasks /Delete', () => {
    assert.ok(cmd.startsWith('schtasks /Delete'));
  });

  it('targets correct task name', () => {
    assert.ok(cmd.includes(`/TN ${TASK_NAME}`));
  });

  it('includes /F to suppress confirmation', () => {
    assert.ok(cmd.includes('/F'));
  });
});

describe('buildQueryCommand', () => {
  const cmd = buildQueryCommand();

  it('uses schtasks /Query', () => {
    assert.ok(cmd.startsWith('schtasks /Query'));
  });

  it('targets correct task name', () => {
    assert.ok(cmd.includes(`/TN ${TASK_NAME}`));
  });

  it('uses LIST format', () => {
    assert.ok(cmd.includes('/FO LIST'));
  });
});
