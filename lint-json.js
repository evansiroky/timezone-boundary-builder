const osmBoundarySources = require('./osmBoundarySources.json')
const zoneCfg = require('./timezones.json')

let numErrors = 0

const sourcesUsage = {}
Object.keys(osmBoundarySources).forEach(source => {
  sourcesUsage[source] = false
})

Object.keys(zoneCfg).forEach(zone => {
  zoneCfg[zone].forEach(operation => {
    if (operation.source === 'overpass') {
      // check if source is defined
      if (!osmBoundarySources[operation.id]) {
        numErrors++

        console.error(`No osmBoundarySources config found for entry: ${operation.id}`)
      } else {
        sourcesUsage[operation.id] = true
      }
    }
  })
})

// check for sources not used in timezone building
Object.keys(sourcesUsage).forEach(source => {
  if (!sourcesUsage[source]) {
    numErrors++
    console.error(`osmBoundarySources config "${source}" is never used in timezone boundary building`)
  }
})

if (numErrors > 0) {
  console.error(`${numErrors} errors found`)
  process.exit(1)
} else {
  console.log('No linting errors!')
}
