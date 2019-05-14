import * as stencila from '@stencila/schema'
import fs from 'fs-extra'
import path from 'path'
import { dump, read } from '../../src'

describe('issue 58', () => {
  const file = path.join(__dirname, '58-list-unordered.gdoc')

  test('goc unordered list is parsed correctly', async () => {
    const gdoc = fs.readJSONSync(file)
    expect(
      gdoc.lists['kix.list.1'].listProperties.nestingLevels[0].glyphType
    ).toBe('GLYPH_TYPE_UNSPECIFIED')

    const article = (await read(file)) as stencila.Article
    expect(article.content && article.content.length).toBe(5)

    // @ts-ignore
    const list = article.content[4] as stencila.List
    expect(list.order).toBe('unordered')
  })

  test('that gdoc converts to the expected md', async () => {
    const article = (await read(file)) as stencila.Article
    const md = await dump(article, 'md')
    expect(md).toBe(`---
title: real converter test
authors: []
---

# This is a file created in the HUB

A para inserted by Nokome

## It will upload to GOOGLE DOCS

-   test
-   test
-   and final test
`)
  })
})
