# Timezone Boundary Builder

The goal of this project is to produce a shapefile with the boundaries of the world's timezones using OpenStreetMap data.

<p align="center"><img src="2018i.png" /></p>

[![Github downloads for all releases](https://img.shields.io/github/downloads/evansiroky/timezone-boundary-builder/total.svg)](https://www.somsubhra.com/github-release-stats/?username=evansiroky&repository=timezone-boundary-builder)  [![GitHub release](https://img.shields.io/github/release/evansiroky/timezone-boundary-builder.svg)](https://github.com/evansiroky/timezone-boundary-builder/releases/latest)


## Shapefiles and data

The shapefiles are available for download in this project's [releases](https://github.com/evansiroky/timezone-boundary-builder/releases). As of release 2018d shapefiles are available with or without oceans.  Each shape or geojson object has a single attribute or property respectively called `tzid`.  The tzid corresponds to the timezone name as defined in the [timezone database](https://www.iana.org/time-zones) (for example: `America/Los_Angeles` or `Asia/Shanghai`).

This project aims to stay up-to-date with all of the currently valid timezones that are defined in the timezone database.  This project also will attempt to provide the most accurate possible boundaries of timezones according to community input.

The underlying data is downloaded from [OpenStreetMap](http://www.openstreetmap.org/) via the [overpass turbo API](http://overpass-turbo.eu/).  Various boundaries are assembled together to produce each zone with various geographic operations.  In numerous edge cases arbitrary boundaries get created in various zones which are noted in the `timezones.json` file.

To maintain consistency with the timezone database, this project will only create a new release after the timezone database creates a new release.  If there are no new timezones created or deleted in a timezone database release, then this project will only create a release if there have been changes performed to the boundary definitions of an existing zone within this project.

## Lookup Libraries

A few common languages already have libraries with an API that can be used to lookup the timezone name at a particular GPS coordinate.  Here are some libraries that use the data produced by timezone-boundary-builder:

| Library | Language |
| -- | -- |
| [ZoneDetect](https://github.com/BertoldVdb/ZoneDetect) | C |
| [go-tz](https://github.com/ugjka/go-tz) | Go |
| [timezoneLookup](https://github.com/evanoberholster/timezoneLookup) | Go |
| [TimeZoneMap](https://github.com/dustin-johnson/timezonemap) | Java & Android |
| [Timeshape](https://github.com/RomanIakovlev/timeshape) | Java |
| [node-geo-tz](https://github.com/evansiroky/node-geo-tz/) | JavaScript (node.js only) |
| [timespace](https://github.com/mapbox/timespace) | JavaScript (node.js and in browser) |
| [tz-lookup](https://github.com/darkskyapp/tz-lookup/) | JavaScript (node.js and in browser) |
| [GeoTimezone](https://github.com/mj1856/GeoTimeZone) | .NET |
| [Geo-Timezone](https://github.com/minube/geo-timezone) | php |
| [timezonefinder](https://github.com/MrMinimal64/timezonefinder) | Python |
| [lutz](https://github.com/ateucher/lutz) | R |

Another common way to use the data for lookup purposes is to load the shapefile into a spatially-aware database.  See this [blog post](https://simonwillison.net/2017/Dec/12/location-time-zone-api/) for an example of how that can be done.

## Running the script

If the data in the releases are not sufficiently recent or you want to build the latest from master, it is possible to run the script to generate the timezones.  However, due to the ever-changing nature of OpenStreetMap, the script should be considered unstable.  The script frequently breaks when unexpected data is received or changes in OpenStreetMap cause validation issues.  Please see the [troubleshooting guide](https://github.com/evansiroky/timezone-boundary-builder/wiki/Troubleshooting) for help with common errors.

**Run the script to generate timezones for all timezones.**

```shell
node --max-old-space-size=8192 index.js
```

**Run the script to generate timezones for only specified timezones.**

```shell
node --max-old-space-size=8192 index.js --filtered-zones "America/New_York,America/Chicago"
```

### What the script does

There are three config files that describe the boundary building process.  The `osmBoundarySources.json` file lists all of the needed boundaries to extract via queries to the Overpass API.  The `timezones.json` file lists all of the timezones and various operations to perform to build the boundaries.  The `expectedZoneOverlaps.json` file lists all timezones that are allowed to overlap each other and the acceptable bounds of a particular overlap.  

The `index.js` file downloads all of the required geometries, builds the specified geometries, validates that there aren't large areas of overlap (other than those that are expected), outputs one huge geojson file, and finally zips up the geojson file using the `zip` cli and also converts the geojson to a shapefile using the `ogr2ogr` cli.  The script has only been verified to run with Node.js 10 on the MacOS platform.

The code does query the publicly available Overpass API, but it self-throttles the making of requests to have a minimum of 4 seconds gap between requests.  If the Overpass API throttles the download, then the gap will be increased exponentially.

## Limitations of this project

The data is almost completely comprised of OpenStreetMap data which is editable by anyone.  There are a few guesses on where to draw an arbitrary border in the open waters and a few sparsely inhabited areas.  Some uninhabited islands are omitted from this project.  This project does include timezones in the oceans, but strictly uses territorial waters or Etc/GMT timezones instead of unofficially observed areas such as Exclusive Economic Zones.

## Contributing

Pull requests are welcome!  Please follow the guidelines listed below:

### Improvements to code

Will be approved subject to code review.

### Changes to timezone boundary configuration

Any change to the boundary of existing timezones must have some explanation of why the change is necessary.  If there are official, publicly available documents of administrative areas describing their timezone boundary please link to them when making your case.  All changes involving an administrative area changing their observed time should instead be sent to the [timezone database](https://www.iana.org/time-zones).

A linting script will verify the integrity of the `timezones.json`, `osmBoundarySources.json` and `expectedZoneOverlaps.json` files.  The script verifies if all needed overpass sources are properly defined and that there aren't any unneeded overpass downloads.  If an operation to make a timezone boundary requires the use of a manual geometry, a description must be added explaining the operation.  All expected zone overlaps must have a description.

## Thanks

Thanks to following people whose open-source and open-data contributions have made this project possible:

- All the maintainers of the [timezone database](https://www.iana.org/time-zones).  
- Eric Muller for constructing and maintaining the timezone shapefile at [efele.net](http://efele.net/maps/tz/world/).  
- The [OpenStreetMap contributor Shinigami](https://www.openstreetmap.org/user/Shinigami) for making lots of edits in OpenStreetMap of various timezone boundaries.
- [Björn Harrtell](https://github.com/bjornharrtell) for all his work and help with [jsts](https://github.com/bjornharrtell/jsts).

## Licenses

The code used to construct the timezone boundaries is licensed under the [MIT License](https://opensource.org/licenses/MIT).

The outputted data is licensed under the [Open Data Commons Open Database License (ODbL)](http://opendatacommons.org/licenses/odbl/).
