const fs = require('fs')
const xlsx = require('xlsx')

const Converter = require('../Converter')

class SheetConverter extends Converter {
  createDom () {
    return this.loadXml(`
      <sheet>
        <meta>
          <name></name>
          <title></title>
          <description></description>
          <columns></columns>
        </meta>
        <data></data>
      </sheet>
    `)
  }

  import (pathFrom, pathTo, volumeFrom, volumeTo) {
    volumeFrom = volumeFrom || fs
    volumeTo = volumeTo || volumeFrom

    return Promise.resolve().then((content) => {
      // The `xlsx` library seems to work best reading from file (rather than parsing data)
      // so for now only support local files
      if (volumeFrom !== fs) throw new Error('Only able to read from a local file system volume')
      if (volumeTo !== fs) throw new Error('Only able to write to a local file system volume')

      const workbook = xlsx.readFile(pathFrom)
      const worksheet = workbook.Sheets[workbook.SheetNames[0]]

      const cellRange = xlsx.utils.decode_range(worksheet['!ref'])
      return this.createDom().then((dom) => {
        const data = dom('data')
        for (let r = 0; r <= cellRange.e.r; r++) {
          const row = dom('<row>')
          for (let c = 0; c <= cellRange.e.c; c++) {
            const ref = xlsx.utils.encode_cell({r: r, c: c})
            const cell = worksheet[ref]
            row.append(
              dom('<cell>').text(cell.v)
            )
          }
          data.append(row)
        }

        return this.writeXml(pathTo, dom, volumeTo).then(() => {
          return pathTo
        })
      })
    })
  }

  export (pathFrom, pathTo, volumeFrom, volumeTo) {
    volumeFrom = volumeFrom || fs
    volumeTo = volumeTo || volumeFrom

    return this.readXml(pathFrom).then((dom) => {
      // The `xlsx` library seems to work best reading from file (rather than parsing data)
      // so for now only support local files
      if (volumeFrom !== fs) throw new Error('Only able to read from a local file system volume')
      if (volumeTo !== fs) throw new Error('Only able to write to a local file system volume')

      const cells = {}
      const data = dom('data')
      let end = {r: 0, c: 0}
      data.find('row').each((r, elem) => {
        let row = dom(elem)
        row.find('cell').each((c, elem) => {
          let cell = dom(elem)
          const text = cell.text()
          if (text) {
            const ref = xlsx.utils.encode_cell({r: r, c: c})
            cells[ref] = {
              t: 's',
              v: text
            }
            end = {r: r, c: c}
          }
        })
      })
      cells['!ref'] = xlsx.utils.encode_range({
        s: {r: 0, c: 0},
        e: end
      })

      const workbook = {
        SheetNames: ['Sheet1'],
        Sheets: {
          Sheet1: cells
        }
      }

      return new Promise((resolve, reject) => {
        xlsx.writeFileAsync(pathTo, workbook, {
          type: 'string'
        }, (err) => {
          err ? reject(err) : resolve(pathTo)
        })
      })
    })
  }
}

module.exports = SheetConverter
