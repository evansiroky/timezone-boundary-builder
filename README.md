# Timezone Boundary Builder

A tool to extract data from Open Street Map (OSM) to build the boundaries of the world's timezones that includes territorial waters.

## How does it work?

There are two config files that describe the boundary building process.  The `osmBoundarySources.json` file lists all of the needed boundaries to extract via queries to the Overpass API.  The `timezones.json` file lists all of the timezones and various operations to perform to build the boundaries.  The `index.js` file downloads all of the required geometries, builds the specified geometries, validates that there aren't large areas of overlap, outputs one huge geojson file, and finally zips up the geojson file using the `zip` cli and also converts the geojson to a shapefile using the `ogr2ogr` cli.  See the releases for the data.

### Special note regarding the Overpass API

Although the code currently queries the publicly available overpass API, this is not recommended because you will get throttled really quickly!  I was able to get away with this because I worked on extracting pieces of data over a few months.  In the future, I hope to make a docker file that downloads a planet dump and starts a local version of the Overpass API to extract the data.

### Running the project

```shell
node --max-old-space-size=8192 index.js
```

## How is this different from the shapefile over at efele.net?

The primary motivation for this project was to develop a dataset of the timezones that includes territorial waters as part of its output.  Another goal is to use as much data as possible about the boundaries from OSM.  In doing these two items, it is intended for the resulting data to allow more accurate predictions on what time it is at any point in the world.  

The data is almost completely comprised of OSM data.  The only exceptions are a few timezone boundaries that appear to be a partial import of the boundaries in the efele.net shapefile and also a few educated guesses on where to draw an arbitrary border in the open waters and a few sparsely inhabited areas.  There are a lot of differences in where the border of all levels of administrative areas are due to differences in the underlying data in OSM and the data source of efele.net's shapefile.  Also, uninhabited islands were frequently omitted from this project.  All of Antarctica is currently omitted as well.

## Contributing

Pull requests are welcome!  Please follow the guidelines listed below:

### Improvements to code

Will be approved subject to code review.  As noted, I hope to create a docker file that starts a local instance of the Overpass API to use to extract data from OSM.  I also hope to add tests in the future to expedite the code review process.  Pull requests are welcome for those two items as well!

### Changes to timezone boundary configuration

Any change to the boundary of existing timezones must have some explanation of why the change is necessary.  If there are official, publicly available documents of administrative areas describing their timezone boundary please link to them when making your case.  All changes involving an administrative area changing their observed time should instead be sent to the [timezone database project](https://www.iana.org/time-zones).

## Future data releases

I hope to at least keep up with updates produced from the timezone database.

In my opinion, the geographic data of the timezone boundaries should reside completely within OSM.  In the future, it may be possible to be able to retrieve all of this data directly from OSM by extracting all relations with a `timezone` tag.  However, there is some controversy as to whether timezone boundary data should be in OSM ([see email thread](https://lists.openstreetmap.org/pipermail/talk-us/2016-May/thread.html#16331)).

## Thanks

Thanks to following people whose open-source and open-data contributions have made this project possible:

- all the maintainers of the timezone database.  
- Eric Muller for constructing and maintaining the timezone shapefile at [efele.net](http://efele.net/maps/tz/world/).  
- The [OSM contributor Shinigami](https://www.openstreetmap.org/user/Shinigami) for making lots of edits in OSM of various timezone boundaries.

## Licenses

The code used to construct the timezone boundaries is licensed under the [MIT License](https://opensource.org/licenses/MIT).

The outputted data is licensed under the [Open Data Commons Open Database License (ODbL)](http://opendatacommons.org/licenses/odbl/).
