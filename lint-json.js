const osmBoundarySources = require('./osmBoundarySources.json')
const zoneCfg = require('./timezones.json')
const expectedZoneOverlaps = require('./expectedZoneOverlaps.json')

let numErrors = 0

const sourcesUsage = {}
Object.keys(osmBoundarySources).forEach(source => {
  sourcesUsage[source] = false
})

Object.keys(zoneCfg).forEach(zone => {
  zoneCfg[zone].forEach((operation, idx) => {
    if (operation.source === 'overpass') {
      // check if source is defined
      if (!osmBoundarySources[operation.id]) {
        numErrors++

        console.error(`No osmBoundarySources config found for entry: ${operation.id}`)
      } else {
        sourcesUsage[operation.id] = true
      }
    } else if (operation.source.indexOf('manual') > -1 &&
      (!operation.description ||
        operation.description.length < 3)) {
      numErrors++

      console.error(`No description of ${operation.source} for operation ${idx} of zone: ${zone}`)
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

// Make sure all expected zone overlaps have a description
Object.keys(expectedZoneOverlaps).forEach(zoneOverlap => {
  expectedZoneOverlaps[zoneOverlap].forEach((overlapBounds, idx) => {
    if (!overlapBounds.description || overlapBounds.description.length < 3) {
      numErrors++
      console.error(`Expected overlap #${idx} of zones ${zoneOverlap} missing description`)
    }
  })
})

if (numErrors > 0) {
  console.error(`${numErrors} errors found`)
  process.exit(1)
} else {
  console.log('No linting errors!')
}
