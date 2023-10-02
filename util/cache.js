const fs = require('fs')
const hasha = require('hasha')

const hashaOpts = { algorithm: 'md5' }

class BaseFileCache {
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

  end (cb) {
    fs.writeFile(
      this.filename, 
      JSON.stringify(this.newCache),
      cb
    )
  }
}

class FileCache extends BaseFileCache {
  calculate ({
    cacheKey,
    calculateFn,
    callback
  }) {
    const cacheVal = this.oldCache[cacheKey]

    if (cacheVal) {
      this.newCache[cacheKey] = cacheVal
      return callback(null, cacheVal)
    }

    calculateFn((err, data) => {
      if (err) return callback(err)
      this.newCache[cacheKey] = data
      callback(null, data)
    })
  }
}

class FileLookupCache extends BaseFileCache{
  calculate ({
    cacheKey,
    outputFilename,
    calculateFn,
    callback,
    returnFile,
    verbose
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
              callback(null, JSON.parse(data))
            }
          )
        } else {
          doCalc()
        }
      })
      .catch(doCalc)
  }
}

module.exports = {
  FileCache,
  FileLookupCache
}