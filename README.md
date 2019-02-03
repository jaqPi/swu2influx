# SWU Echtzeit to InfluxDB Parser

Parser to copy the data provided by [echtzeit.swu.de](https://echtzeit.swu.de/) into InfluxDB. The following tables list the stored data:

## Fields
|  Original Field Name | Database Field Name |  Field Type |  Description                                                                            |
|----------------------|---------------------|-------------|-----------------------------------------------------------------------------------------|
| schedule             | delay               | integer     | Delay in seconds                                                                        |
| lat                  | lat                 | float       | Latitude                                                                                |
| long                 | long                |  float      |  Longitude                                                                              |


## Tags
|  Original Field Name | Database Field Name |  Field Type |  Description                                                                            |
|----------------------|---------------------|-------------|-----------------------------------------------------------------------------------------|
|  fzg                 | vehicle             | integer     | Number of vehicle (unique)                                                              |
| linie                | route               | string      | Number of the route operated by the vehicle                                             |
| uml                  | trip                | integer     |  Number of round trips the vehicle has operated on the current route on a particular    |
| ac                   | ac                  | boolean     |  Vehicle with air conditioning                                                          |
| wifi                 | wifi                | boolean     | Vehicle with free wi-fi                                                                 |
| destination          | ziel                | string      | Current destination                                                                     |
| fw                   | tripPattern         | integer     |                                                                                         |
| typ                  | type                | string      | Type of vehicle: `Bus` or `Strab` (tram)                                                |
|  vt                  | serviceType         | string      | Variation of the route depending on a certain day, e.g. school day, public holiday,.... |
