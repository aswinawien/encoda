import { parse, unparse } from '../src/html'
import { dump, load } from '../src/vfile'

test('parse', async () => {
  expect(await parse(load(kitchenSink.html))).toEqual(kitchenSink.node)
})

test('unparse', async () => {
  expect(dump(await unparse(kitchenSink.node))).toEqual(kitchenSink.html)
})

// An example intended for testing progressively added parser/unparser pairs
const kitchenSink = {
  html: `<html>

  <head>
    <title>Our article</title>
    <script type="application/ld+json">
      {
        "@context": "http://stencila.github.io/schema/stencila.jsonld",
        "type": "Article",
        "title": "Our article",
        "authors": []
      }
    </script>
  </head>

  <body>
    <h1>Heading one</h1>
    <h2>Heading two</h2>
    <h3>Heading three</h3>
    <p>A paragraph with <em>emphasis</em>, <strong>strong</strong>, <del>delete</del>.</p>
    <p>A paragraph with <a href="https://example.org">a <em>rich</em> link</a>.</p>
    <p>A paragraph with <q cite="https://example.org">quote</q>.</p>
    <p>A paragraph with <code class="language-python"># code</code>.</p>
    <p>A paragraph with an image <img alt="caption" src="https://example.org/image.png">.</p>
    <p>Paragraph with a <stencila-boolean>true</stencila-boolean> and a <stencila-boolean>false
      </stencila-boolean>.</p>
    <p>A paragraph with other data: a <stencila-null>null</stencila-null>, a <stencila-number>3.14
      </stencila-number>, and a <stencila-array>[1,2]</stencila-array>.</p>
    <p>A paragraph with an <stencila-object>{a:1,b:'two'}</stencila-object> and a <stencila-thing>
        {type:'Person'}</stencila-thing>.</p>
    <blockquote cite="https://example.org">A blockquote</blockquote>
    <pre><code class="language-r"># Some code
x = c(1,2)</code></pre>
    <ul>
      <li>One</li>
      <li>Two</li>
      <li>Three</li>
    </ul>
    <ol>
      <li>First</li>
      <li>Second</li>
      <li>Third</li>
    </ol>
    <table>
      <tbody>
        <tr>
          <td>A</td>
          <td>B</td>
          <td>C</td>
        </tr>
        <tr>
          <td>1</td>
          <td>2</td>
          <td>3</td>
        </tr>
        <tr>
          <td>4</td>
          <td>5</td>
          <td>6</td>
        </tr>
      </tbody>
    </table>
    <hr>
  </body>

</html>`,

  node: {
    type: 'Article',
    title: 'Our article',
    authors: [],
    content: [
      {
        type: 'Heading',
        depth: 1,
        content: ['Heading one']
      },
      {
        type: 'Heading',
        depth: 2,
        content: ['Heading two']
      },
      {
        type: 'Heading',
        depth: 3,
        content: ['Heading three']
      },
      {
        type: 'Paragraph',
        content: [
          'A paragraph with ',
          {
            type: 'Emphasis',
            content: ['emphasis']
          },
          ', ',
          {
            type: 'Strong',
            content: ['strong']
          },
          ', ',
          {
            type: 'Delete',
            content: ['delete']
          },
          '.'
        ]
      },
      {
        type: 'Paragraph',
        content: [
          'A paragraph with ',
          {
            type: 'Link',
            target: 'https://example.org',
            content: [
              'a ',
              {
                type: 'Emphasis',
                content: ['rich']
              },
              ' link'
            ]
          },
          '.'
        ]
      },
      {
        type: 'Paragraph',
        content: [
          'A paragraph with ',
          {
            type: 'Quote',
            citation: 'https://example.org',
            content: ['quote']
          },
          '.'
        ]
      },
      {
        type: 'Paragraph',
        content: [
          'A paragraph with ',
          {
            type: 'Code',
            language: 'python',
            value: '# code'
          },
          '.'
        ]
      },
      {
        type: 'Paragraph',
        content: [
          'A paragraph with an image ',
          {
            type: 'ImageObject',
            contentUrl: 'https://example.org/image.png',
            caption: 'caption'
          },
          '.'
        ]
      },
      {
        type: 'Paragraph',
        content: ['Paragraph with a ', true, ' and a ', false, '.']
      },
      {
        type: 'Paragraph',
        content: [
          'A paragraph with other data: a ',
          null,
          ', a ',
          3.14,
          ', and a ',
          [1, 2],
          '.'
        ]
      },
      {
        type: 'Paragraph',
        content: [
          'A paragraph with an ',
          { a: 1, b: 'two' },
          ' and a ',
          { type: 'Person' },
          '.'
        ]
      },
      {
        type: 'QuoteBlock',
        citation: 'https://example.org',
        content: ['A blockquote']
      },
      {
        type: 'CodeBlock',
        language: 'r',
        value: '# Some code\nx = c(1,2)'
      },
      {
        type: 'List',
        order: 'unordered',
        items: ['One', 'Two', 'Three']
      },
      {
        type: 'List',
        order: 'ascending',
        items: ['First', 'Second', 'Third']
      },
      {
        type: 'Table',
        rows: [
          {
            type: 'TableRow',
            cells: [
              {
                content: ['A'],
                type: 'TableCell'
              },
              {
                content: ['B'],
                type: 'TableCell'
              },
              {
                content: ['C'],
                type: 'TableCell'
              }
            ]
          },
          {
            type: 'TableRow',
            cells: [
              {
                content: ['1'],
                type: 'TableCell'
              },
              {
                content: ['2'],
                type: 'TableCell'
              },
              {
                content: ['3'],
                type: 'TableCell'
              }
            ]
          },
          {
            type: 'TableRow',
            cells: [
              {
                content: ['4'],
                type: 'TableCell'
              },
              {
                content: ['5'],
                type: 'TableCell'
              },
              {
                content: ['6'],
                type: 'TableCell'
              }
            ]
          }
        ]
      },
      {
        type: 'ThematicBreak'
      }
    ]
  }
}