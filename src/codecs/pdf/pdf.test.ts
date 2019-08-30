import fs from 'fs-extra'
import path from 'path'
import * as vfile from '../../util/vfile'
import articleSimple from '../../__fixtures__/article-simple'
import { defaultEncodeOptions } from '../types'
import { PDFCodec } from './'

const { encode, decode } = new PDFCodec()

jest.setTimeout(30 * 1000) // Extending timeout due to long running test

test('decode', async () => {
  await expect(decode(vfile.create())).rejects.toThrow(
    /Parsing of PDF files is not supported/
  )
})

test('encode', async () => {
  const outputs = path.join(__dirname, '__outputs__')
  await fs.ensureDir(outputs)
  const filePath = path.join(outputs, 'pdf-encode.pdf')
  const doc = await encode(articleSimple, { ...defaultEncodeOptions, filePath })

  expect(Buffer.isBuffer(doc.contents)).toBe(true)
  expect(doc.contents.slice(0, 5).toString()).toBe('%PDF-')
})
