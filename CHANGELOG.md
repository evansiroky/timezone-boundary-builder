## Unreleased

### Zone Changes

* Refactor of timezones in China ([#13](https://github.com/evansiroky/timezone-boundary-builder/issues/13))
  * Integration of areas formerly found in Asia/Chongqing, Asia/Harbin and Asia/Kashgar into other zones
  * Expansion of Asia/Shanghai to all of China except Xinjiang
  * Asia/Urumqi is now comprised of Xinjiang
* Fix Mexico Beach, FL by moving it to central time ([#20](https://github.com/evansiroky/timezone-boundary-builder/issues/20))
* Make Viedma glacier area work with updated OSM boundaries
* Remove small holes and reduce geojson precision. ([#11](https://github.com/evansiroky/timezone-boundary-builder/issues/11) and [#17](https://github.com/evansiroky/timezone-boundary-builder/issues/17))
* Remove zones found in backward file of timezone db ([#16](https://github.com/evansiroky/timezone-boundary-builder/issues/16))
  * America/Coral_Harbour now integrated into America/Atikokan
  * America/Montreal now integrated into America/Toronto
  * See notes on China refactor for changes to Asia/Chongqing, Asia/Harbin, Asia/Kashgar, Asia/Shanghai and Asia/Urumqi
  * Asia/Rangoon renamed to Asia/Yangon
  * Pacific/Yap integrated into Pacific/Chuuk
  * Pacific/Johnston integrated into Pacific/Honolulu
* Add Page, AZ to America/Phoenix ([#9](https://github.com/evansiroky/timezone-boundary-builder/issues/9))
* Update to latest OSM data

### Other Changes

* Add linting of json files
  * A overpass source listed in timezones.json must have a corresponding definition in osmBoundarySources.json
  * A overpass source defined in osmBoundarySources.json must be used in at least one operation in timezones.json
  * A manual-polygon or manual-multipolygon defined in timezones.json must be accompanied with a description.
* Add ability to build only certain zones in builder script
* Add travis-ci builds that require linting script to pass
* Added descriptions to manual geometries

## 2017a

* Zone Changes
  * Add new zone America/Punta_Arenas by taking area from America/Santiago
  * Move the boundary of America/New_York and America/Chicago in the region of various towns in Alabama such as Phenix City to the west to include these towns in America/New_York
  * Implement own interpretation of border of America/Chicago and America/Denver in the following places:
    * Move boundary to the east of ND Highway 31 in Sioux county, ND
    * Move diagonal boundary through Stanley County, SD northwest so it doesn't go through the middle of Fort Pierre
  * Update to latest OSM data
* Other changes
  * Add picture of zones to README

## 2016j

- Zone Changes
  - Add new zone Asia/Atyrau by taking area from Asia/Aqtau
  - Add new zone Europe/Saratov by taking area from Europe/Volgograd
  - Update to latest OSM data
- Other changes
  - README updates


## 2016i

- Zone Changes
  - Split Cyprus into 2 zones.  The existing Asia/Nicosia now ends at
    the northern boundary of the United Nations Buffer Zone and the new
    zone Asia/Famagusta contains everything north of the buffer zone.
  - Add missing data definitions: Congo-Kinshasa and South Sudan
  - Old Crimea boundary no longer exists in OSM, use combination of
    Crimea + Sevastopol
  - Typo of extra space in Harrison County fixed in OSM
  - Taishan City now has invalid geometry in OSM, use Xinhui district
    instead when making boundaries
  - Update to latest OSM data
- Other changes
  - Add download throttling of publicly available Overpass API
  - Remove old dist files if they exist so ogr2ogr can work
  - Update README to note change in Overpass API querying


## 2016d

First data release of the project.
