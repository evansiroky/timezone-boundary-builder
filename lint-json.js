const osmBoundarySources = require('./osmBoundarySources.json')
const zoneCfg = require('./timezones.json')
const expectedZoneOverlaps = require('./expectedZoneOverlaps.json')
const zoneCfg1970 = require('./timezones-1970.json')

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

// Check 1970 zones for:
// 1. All full timezone names being included in 1970 components
// 2. Component timezones are only ever used once
// 3. No zones being in 1970 that aren't in the full timezone set
const zonesFoundToMake1970 = new Set()
Object.keys(zoneCfg1970).forEach(zone => {
  zoneCfg1970[zone].forEach(zoneComponent => {
    // check if 1970 zone is used twice
    if (zonesFoundToMake1970.has(zoneComponent)) {
      numErrors++
      console.error(`${zoneComponent} used twice to make a 1970 zone`)
    }
    zonesFoundToMake1970.add(zoneComponent)

    // check if 1970 zone is present in zone config
    if (!zoneCfg[zoneComponent]) {
      numErrors++
      console.error(`${zoneComponent} not used in full timezone set`)
    }
  })
})

Object.keys(zoneCfg).forEach(zone => {
  if (!zonesFoundToMake1970.has(zone)) {
    numErrors++
    console.error(`${zone} not used as a component to make a 1970 zone`)
  }
})

if (numErrors > 0) {
  console.error(`${numErrors} errors found`)
  process.exit(1)
} else {
  console.log('No linting errors!')
}
