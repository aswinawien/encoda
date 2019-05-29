/**
 * # PDF unparser
 *
 * @module pdf
 */

/** A comment required for above to be included in docs.
 * See https://github.com/christopherthielen/typedoc-plugin-external-module-name/issues/300
 */

import * as stencila from '@stencila/schema'
import { dump } from './index'
import * as puppeteer from './puppeteer'
import { load, VFile } from './vfile'

/**
 * The media types that this compiler can parse/unparse.
 */
export const mediaTypes = ['application/pdf']

// The above media type is registered in the `mime` module
// so there is no need to specify `extNames`

/**
 * This function is required (currently) but is (and probably never will be)
 * implemented.
 */
export async function parse(file: VFile): Promise<stencila.Node> {
  throw new Error(`Parsing of PDF files is not supported.`)
}

// The Puppeteer page that will be used to generate PDFs
export const browser = puppeteer.page()

/**
 * Unparse a Stencila `Node` to a `VFile` with PDF content.
 *
 * @param node The Stencila `Node` to unparse
 * @param filePath The file system path to write the PDF to
 * @returns A promise that resolves to a `VFile`
 */
export async function unparse(
  node: stencila.Node,
  filePath?: string
): Promise<VFile> {
  const html = await dump(node, 'html')

  const page = await browser()
  await page.setContent(html, { waitUntil: 'networkidle0' })
  const buffer = await page.pdf({
    path: filePath,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '2.54cm',
      bottom: '2.54cm',
      left: '2.54cm',
      right: '2.54cm'
    }
  })

  return load(buffer)
}
