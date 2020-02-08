/**
 * @module util/puppeteer
 */

import { getLogger } from '@stencila/logga'
import AsyncLock from 'async-lock'
import fs from 'fs-extra'
import path from 'path'
import puppeteer from 'puppeteer'
import isPackaged from './app/isPackaged'

const log = getLogger('encoda:puppeteer')

/**
 * The following code is necessary to ensure the Chromium binary can be correctly
 * found when bundled as a binary using [`pkg`](https://github.com/zeit/pkg).
 * See: [`pkg-puppeteer`](https://github.com/rocklau/pkg-puppeteer)
 */

// Adapts the regex path to work on both Windows and *Nix platforms
const pathRegex =
  process.platform === 'win32'
    ? /^.*?\\node_modules\\puppeteer\\\.local-chromium/
    : /^.*?\/node_modules\/puppeteer\/\.local-chromium/

export const executablePath = isPackaged
  ? puppeteer
      .executablePath()
      .replace(
        pathRegex,
        path.join(
          path.dirname(process.execPath),
          'node_modules',
          'puppeteer',
          '.local-chromium'
        )
      )
  : puppeteer.executablePath()

if (!fs.pathExists(executablePath))
  log.error(`Chromium does not exist in expected location: ${executablePath}`)

/**
 * Module global Puppeteer instance
 * and mutex lock to prevent conflicts between
 * concurrent requests to `startup` or `shutdown`
 */
let browser: puppeteer.Browser | undefined
const lock = new AsyncLock()

/**
 * Startup the browser if it isn't already.
 *
 * This needs to use a mutex lock to ensure that multiple
 * async calls to startup() don't race to create the
 * singleton browser instance.
 */
export async function startup(): Promise<puppeteer.Browser> {
  return lock.acquire(
    'browser',
    async (): Promise<puppeteer.Browser> => {
      if (typeof browser === 'undefined') {
        log.debug('Launching new browser')
        browser = await puppeteer.launch({
          executablePath,
          pipe: true,
          // Use /tmp instead of /dev/shm to avoid issues like: https://dev.azure.com/stencila/stencila/_build/results?buildId=205&view=logs&j=b17395f6-68a3-5682-0476-d3f6f1043109&t=e59dc482-4022-5828-e063-e9c9e022e048&l=440
          // See https://github.com/puppeteer/puppeteer/blob/master/docs/troubleshooting.md#tips
          args: ['--disable-dev-shm-usage']
        })
        log.debug(`Browser launched. pid: ${browser.process().pid}`)
      }
      return browser
    }
  )
}

/**
 * Create a new page
 */
export async function page(): Promise<puppeteer.Page> {
  const browser = await startup()
  return browser.newPage()
}

/**
 * Close the browser.
 */
export async function shutdown(): Promise<void> {
  await lock.acquire(
    'browser',
    async (): Promise<void> => {
      if (browser !== undefined) {
        log.debug(`Closing browser. pid: ${browser.process().pid}`)
        await browser.close()
        log.debug('Browser closed')
        browser = undefined
      }
    }
  )
}

// Always shutdown before exiting the Node process
// We use `beforeExit` because async operations are not supported
// by `exit`.
// See https://nodejs.org/api/process.html#process_event_beforeexit
process.on('beforeExit', () => {
  shutdown().catch(error => {
    throw error
  })
})
