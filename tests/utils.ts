/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect as baseExpect, test as baseTest, Browser, BrowserContextOptions, chromium, Page } from '@playwright/test';
// @ts-ignore
import { Extension } from '../out/extension';
import { TestController, VSCode, WorkspaceFolder, TestRun, TestItem } from './mock/vscode';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

process.env.PW_DEBUG_CONTROLLER_HEADLESS = '1';
// the x-pw-highlight element has otherwise a closed shadow root.
process.env.PWTEST_UNDER_TEST = '1';

type ActivateResult = {
  vscode: VSCode,
  testController: TestController;
  workspaceFolder: WorkspaceFolder;
};

type Latch = {
  blockingCode: string;
  open: () => void;
  close: () => void;
};

type TestFixtures = {
  vscode: VSCode,
  activate: (files: { [key: string]: string }, options?: { rootDir?: string, workspaceFolders?: [string, any][], env?: Record<string, any>, runGlobalSetupOnEachRun?: boolean }) => Promise<ActivateResult>;
  createLatch: () => Latch;
};

export type WorkerOptions = {
  overridePlaywrightVersion?: number;
  showBrowser: boolean;
  showTrace?: boolean;
  vsCodeVersion: number;
};

// Make sure connect tests work with the locally-rolled version.
process.env.PW_VERSION_OVERRIDE = require('@playwright/test/package.json').version;

export const expect = baseExpect.extend({
  async toHaveTestTree(testController: TestController, expectedTree: string) {
    try {
      await expect.poll(() => testController.renderTestTree()).toBe(expectedTree);
      return { pass: true, message: () => '' };
    } catch (e) {
      return {
        pass: false,
        message: () => String(e)
      };
    }
  },

  async toHaveExecLog(vscode: VSCode, expectedLog: string) {
    if (!vscode.extensions[0].overridePlaywrightVersion)
      return { pass: true, message: () => '' };
    try {
      await expect.poll(() => vscode.renderExecLog('  ')).toBe(expectedLog);
      return { pass: true, message: () => '' };
    } catch (e) {
      return {
        pass: false,
        message: () => String(e)
      };
    }
  },

  async toHaveProjectTree(vscode: VSCode, expectedTree: string) {
    try {
      await expect.poll(() => vscode.renderProjectTree().then(s => s.trim().replace(/\\/, '/'))).toBe(expectedTree.trim());
      return { pass: true, message: () => '' };
    } catch (e) {
      return {
        pass: false,
        message: () => String(e)
      };
    }
  },

  async toHaveOutput(testRun: TestRun, expectedOutput: string | RegExp) {
    try {
      await expect.poll(() => testRun.renderOutput()).toMatch(expectedOutput);
      return { pass: true, message: () => '' };
    } catch (e) {
      return {
        pass: false,
        message: () => String(e)
      };
    }
  },

  async toHaveConnectionLog(vscode: VSCode, expectedLog: any) {
    if (vscode.extensions[0].overridePlaywrightVersion)
      return { pass: true, message: () => '' };
    const filterCommands = new Set(['ping', 'initialize']);
    const filteredLog = () => {
      return vscode.connectionLog.filter(e => !filterCommands.has(e.method));
    };
    try {
      await expect.poll(() => filteredLog()).toEqual(expectedLog);
      return { pass: true, message: () => '' };
    } catch (e) {
      return {
        pass: false,
        message: () => String(e)
      };
    }
  },
});

export const test = baseTest.extend<TestFixtures, WorkerOptions>({
  overridePlaywrightVersion: [undefined, { option: true, scope: 'worker' }],
  showBrowser: [false, { option: true, scope: 'worker' }],
  showTrace: [undefined, { option: true, scope: 'worker' }],
  vsCodeVersion: [1.86, { option: true, scope: 'worker' }],

  vscode: async ({ browser, vsCodeVersion }, use) => {
    await use(new VSCode(vsCodeVersion, path.resolve(__dirname, '..'), browser));
  },

  activate: async ({ vscode, showBrowser, overridePlaywrightVersion, showTrace }, use, testInfo) => {
    const instances: VSCode[] = [];
    await use(async (files: { [key: string]: string }, options?: { rootDir?: string, workspaceFolders?: [string, any][], env?: Record<string, any>, runGlobalSetupOnEachRun?: boolean }) => {
      if (options?.workspaceFolders) {
        for (const wf of options?.workspaceFolders)
          await vscode.addWorkspaceFolder(wf[0], wf[1]);
      } else {
        await vscode.addWorkspaceFolder(options?.rootDir || testInfo.outputDir, files);
      }

      const configuration = vscode.workspace.getConfiguration('playwright');
      if (options?.env)
        configuration.update('env', options.env);
      if (options?.runGlobalSetupOnEachRun)
        configuration.update('runGlobalSetupOnEachRun', true);
      if (showBrowser)
        configuration.update('reuseBrowser', true);
      if (showTrace) {
        configuration.update('showTrace', true);

        // prevents spawn trace viewer process from opening app and browser
        vscode.env.remoteName = 'ssh-remote';
        process.env.PWTEST_UNDER_TEST = '1';
      }

      const extension = new Extension(vscode, vscode.context);
      if (overridePlaywrightVersion)
        extension.overridePlaywrightVersion = overridePlaywrightVersion;

      vscode.extensions.push(extension);
      await vscode.activate();

      instances.push(vscode);
      return {
        vscode,
        testController: vscode.testControllers[0],
        workspaceFolder: vscode.workspace.workspaceFolders[0],
      };
    });
    for (const vscode of instances)
      vscode.dispose();
  },

  // Copied from https://github.com/microsoft/playwright/blob/7e7319da7d84de6648900e27e6d844bec9071222/tests/playwright-test/ui-mode-fixtures.ts#L132
  createLatch: async ({}, use, testInfo) => {
    await use(() => {
      const latchFile = path.join(testInfo.project.outputDir, createGuid() + '.latch');
      return {
        blockingCode: `await ((${waitForLatch})(${JSON.stringify(latchFile)}))`,
        open: () => fs.writeFileSync(latchFile, 'ok'),
        close: () => fs.unlinkSync(latchFile),
      };
    });
  },
});

export async function connectToSharedBrowser(vscode: VSCode) {
  await expect.poll(() => vscode.extensions[0].browserServerWSForTest()).toBeTruthy();
  const wsEndpoint = vscode.extensions[0].browserServerWSForTest();
  return await chromium.connect(wsEndpoint);
}

export async function waitForRecorderMode(vscode: VSCode, mode: string) {
  await expect.poll(() => vscode.extensions[0].recorderModeForTest()).toBe(mode);
}

export async function waitForPage(browser: Browser, params?: BrowserContextOptions) {
  let pages: Page[] = [];
  await expect.poll(async () => {
    const context = await (browser as any)._newContextForReuse(params);
    pages = context.pages();
    return pages.length;
  }).toBeTruthy();
  return pages[0];
}

export async function enableConfigs(vscode: VSCode, labels: string[]) {
  let success = false;
  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  while (!success) {
    vscode.window.mockQuickPick = async (items: TestItem[]) => {
      let allFound = true;
      for (const label of labels) {
        if (!items.find(i => i.label === label))
          allFound = false;
      }
      // Wait for all the selected options to become available, discard.
      if (!allFound) {
        await new Promise(f => setTimeout(f, 100));
        return undefined;
      }
      success = true;
      return items.filter(i => labels.includes(i.label));
    };
    await webView.getByTitle('Toggle Playwright Configs').click();
  }
}

export async function selectConfig(vscode: VSCode, label: string) {
  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await webView.getByTestId('models').selectOption({ label });
}

export async function enableProjects(vscode: VSCode, projects: string[]) {
  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  const projectLocators = await webView.getByTestId('projects').locator('div').locator('label').all();
  for (const projectLocator of projectLocators) {
    const name = await projectLocator.textContent();
    await projectLocator.locator('input').setChecked(projects.includes(name!));
  }
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const escapedPathSep = escapeRegex(path.sep);

export function selectTestItem(testItem: TestItem) {
  testItem.testController.vscode.extensions[0].fireTreeItemSelectedForTest(testItem);
}

export async function singleWebViewByPanelType(vscode: VSCode, viewType: string) {
  await expect.poll(() => vscode.webViewsByPanelType(viewType)).toHaveLength(1);
  return vscode.webViewsByPanelType(viewType)[0];
}

export async function traceViewerInfo(vscode: VSCode): Promise<{ type: 'spawn', serverUrlPrefix?: string, testConfigFile: string, traceFile: string } | undefined> {
  return await vscode.extensions[0].traceViewerInfoForTest();
}

async function waitForLatch(latchFile: string) {
  const fs = require('fs');
  while (!fs.existsSync(latchFile))
    await new Promise(f => setTimeout(f, 250));
}

function createGuid(): string {
  return crypto.randomBytes(16).toString('hex');
}
