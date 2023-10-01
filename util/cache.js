const fs = require('fs')
const hasha = require('hasha')

const hashaOpts = { algorithm: 'md5' }

class FileCache {
  constructor ({ filename }) {
    this.filename = filename
    this.oldCache = {}
    this.newCache = {}
  }

  init (cb) {
    fs.readFile(
      this.filename,
      { encoding: 'utf-8' },
      (err, data) => {
        if (err) {
          return cb()
        } else {
          try {
            this.oldCache = JSON.parse(data) 
          } catch (error) {}
          cb()
        }
      }
    ) 
  }

  calculate ({
    cacheKey,
    outputFilename,
    calculateFn,
    callback,
    returnFile
  }) {
    const cacheVal = this.oldCache[cacheKey]

    const doCalc = () => {
      calculateFn((err, data) => {
        if (err) return callback(err)
        fs.writeFile(
          outputFilename, 
          data, 
          error => {
            if (error) return callback(error)
            hasha.fromFile(outputFilename, hashaOpts)
              .then(val => {
                this.newCache[cacheKey] = val
                if (returnFile) {
                  callback(null, JSON.parse(data))
                } else {
                  callback()
                }
              })
              .catch(callback)
          }
        )
      })
    }

    hasha.fromFile(outputFilename, hashaOpts)
      .then(val => {
        if (val === cacheVal) {
          // cache hit
          this.newCache[cacheKey] = val
          if (!returnFile) return callback()
          fs.readFile(
            outputFilename,
            { encoding: 'utf-8' },
            (err, data) => {
              if (err) return callback(err)
              return callback(null, JSON.parse(data))
            }
          )
        }
        doCalc()
      })
      .catch(doCalc)
  }

  end (cb) {
    fs.writeFile(
      this.filename, 
      JSON.stringify(this.newCache),
      cb
    )
  }
}

module.exports = {
  FileCache
}