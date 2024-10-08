import path from 'node:path'
import { rm } from 'node:fs/promises'
import stripAnsi from 'strip-ansi'
import * as vscode from 'vscode'
import { getTasks } from '@vitest/ws-client'
import type { ParsedStack, RunnerTestFile, TaskResult, TestError } from 'vitest'
import { basename, normalize, relative } from 'pathe'
import { TestCase, TestFile, TestFolder, getTestData } from '../testTreeData'
import type { TestTree } from '../testTree'
import type { VitestFolderAPI } from '../api'
import { log } from '../log'
import { showVitestError } from '../utils'
import { coverageContext, readCoverageReport } from '../coverage'

export class TestRunner extends vscode.Disposable {
  private continuousRequests = new Set<vscode.TestRunRequest>()
  private nonContinuousRequest: vscode.TestRunRequest | undefined

  private _onRequestsExhausted = new vscode.EventEmitter<void>()

  private testRun: vscode.TestRun | undefined
  private testRunDefer: PromiseWithResolvers<void> | undefined

  constructor(
    private readonly controller: vscode.TestController,
    private readonly tree: TestTree,
    private readonly api: VitestFolderAPI,
  ) {
    super(() => {
      log.verbose?.('Disposing test runner')
      api.clearListeners()
      this.testRun?.end()
      this.testRun = undefined
      this.testRunDefer?.resolve()
      this.testRunDefer = undefined
      this.nonContinuousRequest = undefined
      this.continuousRequests.clear()
      this.api.cancelRun()
      this._onRequestsExhausted.dispose()
    })

    api.onWatcherRerun((files, _trigger, collecting) => {
      if (collecting) {
        log.verbose?.('Not starting the runner because tests are being collected')
      }
      else {
        log.verbose?.('The runner is starting because tests', ...files, 'were started due to a file change')
        this.startTestRun(files)
      }
    })

    api.onTaskUpdate((packs) => {
      packs.forEach(([testId, result]) => {
        const test = this.tree.getTestItemByTaskId(testId)
        if (!test) {
          log.error('Cannot find task during onTaskUpdate', testId)
          return
        }
        const testRun = this.testRun
        // there is no test run for collected tests
        if (!testRun) {
          log.verbose?.(`There is no test run for "${test.label}"`)
          return
        }

        this.markResult(testRun, test, result)
      })
    })

    api.onCollected((files, collecting) => {
      if (!files) {
        log.verbose?.('No files to collect')
        return
      }
      files.forEach(file => this.tree.collectFile(this.api, file))
      if (collecting)
        return

      getTasks(files).forEach((task) => {
        const test = this.tree.getTestItemByTask(task)
        if (!test) {
          log.error(`Test data not found for "${task.name}"`)
          return
        }
        const testRun = this.testRun
        if (!testRun) {
          return
        }

        if (task.mode === 'skip' || task.mode === 'todo') {
          log.verbose?.(`Marking "${test.label}" as skipped during collection`)
          testRun.skipped(test)
        }
        else {
          this.markResult(testRun, test, task.result)
        }
      })
    })

    api.onFinished(async (files = [], unhandledError, collecting) => {
      const testRun = this.testRun
      if (!testRun) {
        log.verbose?.('No test run to finish for', files.map(f => f.filepath).join(', '))
        return
      }

      try {
        if (!collecting)
          await this.reportCoverage(files)
      }
      catch (err: any) {
        showVitestError(`Failed to report coverage. ${err.message}`, err)
      }

      files.forEach((file) => {
        const testItem = this.tree.getTestItemByTask(file)
        if (testItem) {
          this.markResult(testRun, testItem, file.result)
        }
        else {
          log.verbose?.('Could not find test item for', file.filepath)
        }
      })

      if (unhandledError)
        testRun.appendOutput(formatTestOutput(unhandledError))

      this.endTestRun()
    })

    api.onConsoleLog(({ content, taskId }) => {
      const testItem = taskId ? tree.getTestItemByTaskId(taskId) : undefined
      const testRun = this.testRun
      if (testRun) {
        testRun.appendOutput(
          formatTestOutput(content),
          undefined,
          testItem,
        )
      }
      else {
        log.info('[TEST]', content)
      }
    })
  }

  protected endTestRun() {
    log.verbose?.('Ending test run', this.testRun?.name || '<none>')
    this.testRun?.end()
    this.testRunDefer?.resolve()
    this.testRun = undefined
    this.testRunDefer = undefined
  }

  private async watchContinuousTests(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    this.continuousRequests.add(request)

    token.onCancellationRequested(() => {
      log.verbose?.('Continuous test run for', join(request.include), 'was cancelled')

      this.continuousRequests.delete(request)
      if (!this.continuousRequests.size) {
        log.verbose?.('Stopped watching test files')
        this._onRequestsExhausted.fire()
        this.api.unwatchTests()
        this.endTestRun()
      }
    })

    if (!request.include?.length) {
      log.info('[RUNNER]', 'Watching all test files')
      await this.api.watchTests()
    }
    else {
      const include = [...this.continuousRequests].map(r => r.include || []).flat()
      const files = getTestFiles(include)
      const testNamePatern = formatTestPattern(include)
      log.info(
        '[RUNNER]',
        'Watching test files:',
        files.map(f => relative(this.api.workspaceFolder.uri.fsPath, f)).join(', '),
        testNamePatern ? `with pattern ${testNamePatern}` : '',
      )
      await this.api.watchTests(files, testNamePatern)
    }
  }

  public async runCoverage(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    try {
      await this.api.enableCoverage()
    }
    catch (err: any) {
      showVitestError(`Failed to enable coverage. ${err.message}`, err)
      return
    }

    const { dispose } = this._onRequestsExhausted.event(() => {
      if (!this.continuousRequests.size && !this.nonContinuousRequest) {
        log.verbose?.('Coverage was disabled due to all requests being exhausted')
        this.api.disableCoverage()
        dispose()
      }
    })

    token.onCancellationRequested(() => {
      log.verbose?.('Coverage for', join(request.include), 'was manually stopped')
      this.api.disableCoverage()
    })

    await this.runTests(request, token)
  }

  public async runTests(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    // if request is continuous, we just mark it and wait for the changes to files
    // users can also click on "run" button to trigger the run
    if (request.continuous)
      return await this.watchContinuousTests(request, token)

    this.nonContinuousRequest = request

    token.onCancellationRequested(() => {
      this.endTestRun()
      this.nonContinuousRequest = undefined
      this.api.cancelRun()
      log.verbose?.('Test run was cancelled manually for', join(request.include))
    })

    await this.runTestItems(request)

    this.nonContinuousRequest = undefined
    this._onRequestsExhausted.fire()
  }

  protected async runTestItems(request: vscode.TestRunRequest) {
    if (this.testRunDefer) {
      log.verbose?.('Waiting for the previous test run to finish')
      await this.testRunDefer.promise
    }

    this.testRunDefer = Promise.withResolvers()

    const runTests = (files?: string[], testNamePatern?: string) =>
      'updateSnapshots' in request
        ? this.api.updateSnapshots(files, testNamePatern)
        : this.api.runFiles(files, testNamePatern)

    const tests = request.include || []
    const root = this.api.workspaceFolder.uri.fsPath
    if (!tests.length) {
      log.info(`Running all tests in ${basename(root)}`)
      await runTests()
    }
    else {
      const testNamePatern = formatTestPattern(tests)
      const files = getTestFiles(tests)
      if (testNamePatern)
        log.info(`Running ${files.length} file(s) with name pattern: ${testNamePatern}`)
      else
        log.info(`Running ${files.length} file(s):`, files.map(f => relative(root, f)))
      await runTests(files, testNamePatern)
    }
  }

  private isFileIncluded(file: string, include: readonly vscode.TestItem[] | vscode.TestItemCollection) {
    for (const _item of include) {
      const item = 'id' in _item ? _item : _item[1]
      const data = getTestData(item)
      if (data instanceof TestFile) {
        if (data.filepath === file)
          return true
      }
      else if (data instanceof TestFolder) {
        if (this.isFileIncluded(file, item.children))
          return true
      }
      else {
        if (data.file.filepath === file)
          return true
      }
    }
    return false
  }

  private getTestFilesInFolder(path: string) {
    const folder = this.tree.getOrCreateFolderTestItem(this.api, path)
    const items = this.tree.getFolderFiles(folder)
    return Array.from(
      new Set(items.map(item => (getTestData(item) as TestFile).filepath)),
    )
  }

  private createContinuousRequest() {
    if (!this.continuousRequests.size)
      return null
    const include = []
    let primaryRequest: vscode.TestRunRequest | null = null
    for (const request of this.continuousRequests) {
      if (!primaryRequest)
        primaryRequest = request
      include.push(...request.include || [])
    }
    return new vscode.TestRunRequest(
      include.length ? include : undefined,
      undefined,
      primaryRequest?.profile,
      true,
    )
  }

  private async startTestRun(files: string[], primaryRequest?: vscode.TestRunRequest) {
    const request = primaryRequest || this.nonContinuousRequest || this.createContinuousRequest()

    if (!request) {
      log.verbose?.('No test run request found for', ...files)
      return
    }

    if (this.testRun) {
      log.verbose?.('Waiting for the previous test run to finish')
      await this.testRunDefer?.promise
      this.endTestRun()
    }

    const name = files.length > 1
      ? undefined
      : relative(this.api.workspaceFolder.uri.fsPath, files[0])

    const run = this.testRun = this.controller.createTestRun(request, name)

    for (const file of files) {
      if (file[file.length - 1] === '/') {
        const files = this.getTestFilesInFolder(file)
        this.startTestRun(files, request)
        continue
      }

      // during test collection, we don't have test runs
      if (request.include && !this.isFileIncluded(file, request.include))
        continue

      const testItems = request.include || this.tree.getFileTestItems(file)
      function enqueue(test: vscode.TestItem) {
        log.verbose?.(`Enqueuing "${test.label}`)
        run.enqueued(test)
        test.children.forEach(enqueue)
      }
      testItems.forEach(test => enqueue(test))
    }
  }

  public async reportCoverage(files: RunnerTestFile[]) {
    if (!('FileCoverage' in vscode))
      return

    const reportsDirectory = await this.api.waitForCoverageReport()
    if (!reportsDirectory)
      return

    const coverage = readCoverageReport(reportsDirectory)

    const promises = files.map(async () => {
      const testRun = this.testRun
      if (testRun)
        await coverageContext.applyJson(testRun, coverage)
    })

    await Promise.all(promises)

    rm(reportsDirectory, { recursive: true, force: true }).catch(() => {
      log.error('Failed to remove coverage reports', reportsDirectory)
    })
  }

  private markSuite(_testRun: vscode.TestRun, test: vscode.TestItem, result?: TaskResult) {
    if (!result)
      return

    if (result.state === 'fail') {
      // errors in a suite are stored only if it happens during discovery
      const errors = result.errors?.map(err =>
        err.stack || err.message,
      )
      if (!errors?.length) {
        log.verbose?.(`No errors found for "${test.label}"`)
        return
      }
      log.verbose?.(`Marking "${test.label}" as failed with ${errors.length} errors`)
      test.error = errors.join('\n')
    }
  }

  private markTestCase(
    testRun: vscode.TestRun,
    test: vscode.TestItem,
    result: TaskResult,
  ) {
    switch (result.state) {
      case 'fail': {
        const errors = result.errors?.map(err =>
          testMessageForTestError(test, err as TestError),
        ) || []
        if (!errors.length) {
          log.verbose?.(`Test failed, but no errors found for "${test.label}"`)
          return
        }
        log.verbose?.(`Marking "${test.label}" as failed with ${errors.length} errors`)
        testRun.failed(test, errors, result.duration)
        break
      }
      case 'pass':
        log.verbose?.(`Marking "${test.label}" as passed`)
        testRun.passed(test, result.duration)
        break
      case 'todo':
      case 'skip':
        log.verbose?.(`Marking "${test.label}" as skipped`)
        testRun.skipped(test)
        break
      case 'only':
      case 'run':
        log.verbose?.(`Marking "${test.label}" as running`)
        testRun.started(test)
        break
      default: {
        const _never: never = result.state
        log.error('Unknown test result for', `${test.label}: ${result.state}`)
      }
    }
  }

  private markResult(testRun: vscode.TestRun, test: vscode.TestItem, result?: TaskResult) {
    const isTestCase = getTestData(test) instanceof TestCase

    // generally, we shouldn't mark non test cases because
    // parents are calculated based on children
    if (!isTestCase) {
      return this.markSuite(testRun, test, result)
    }

    if (!result) {
      log.verbose?.(`No task result for "${test.label}", assuming the test just started running`)
      testRun.started(test)
      return
    }

    this.markTestCase(testRun, test, result)
  }
}

function testMessageForTestError(testItem: vscode.TestItem, error: TestError | undefined): vscode.TestMessage {
  if (!error)
    return new vscode.TestMessage('Unknown error')

  let testMessage
  if (error.actual != null && error.expected != null && error.actual !== 'undefined' && error.expected !== 'undefined')
    testMessage = vscode.TestMessage.diff(stripAnsi(error.message) ?? '', error.expected, error.actual)
  else
    testMessage = new vscode.TestMessage(stripAnsi(error.message) ?? '')

  const location = parseLocationFromStacks(testItem, error.stacks ?? [])
  if (location) {
    const position = new vscode.Position(location.line - 1, location.column - 1)
    testMessage.location = new vscode.Location(vscode.Uri.file(location.path), position)
  }
  return testMessage
}

export interface DebuggerLocation {
  path: string
  line: number
  column: number
}

function getSourceFilepathAndLocationFromStack(stack: ParsedStack): { sourceFilepath?: string; line: number; column: number } {
  return {
    sourceFilepath: stack.file.replace(/\//g, path.sep),
    line: stack.line,
    column: stack.column,
  }
}

function parseLocationFromStacks(testItem: vscode.TestItem, stacks: ParsedStack[]): DebuggerLocation | undefined {
  if (stacks.length === 0)
    return undefined

  const targetFilepath = testItem.uri!.fsPath
  for (const stack of stacks) {
    const { sourceFilepath, line, column } = getSourceFilepathAndLocationFromStack(stack)
    if (sourceFilepath !== targetFilepath || Number.isNaN(column) || Number.isNaN(line))
      continue

    return {
      path: sourceFilepath,
      line,
      column,
    }
  }

  log.verbose?.('Could not find a valid stack for', testItem.label, JSON.stringify(stacks, null, 2))
}

function getTestFiles(tests: readonly vscode.TestItem[]) {
  return Array.from(
    new Set(tests.map((test) => {
      const data = getTestData(test)
      const fsPath = normalize(test.uri!.fsPath)
      if (data instanceof TestFolder)
        return `${fsPath}/`
      return fsPath
    }).filter(Boolean) as string[]),
  )
}

function formatTestPattern(tests: readonly vscode.TestItem[]) {
  const patterns: string[] = []
  for (const test of tests) {
    const data = getTestData(test)!
    if (!('getTestNamePattern' in data))
      continue
    patterns.push(data.getTestNamePattern())
  }
  if (!patterns.length)
    return undefined
  return patterns.join('|')
}

function formatTestOutput(output: string) {
  return output.replace(/(?<!\r)\n/g, '\r\n')
}

function join(items: readonly vscode.TestItem[] | undefined) {
  if (!items)
    return '<all tests>'
  return items.map(p => p.label).join(', ')
}
