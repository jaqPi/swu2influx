const rp = require('request-promise');
const parser = require('fast-xml-parser');
const he = require('he');
const Influx = require('influx');

const basePath = 'https://echtzeit.swu.de';
const api = '/php/phpsqlajax_genxml.php?src=gps';
const sleepTime = 15000;

const influxServerIp = process.env.INFLUXDB_HOST;
const username = process.env.INFLUXDB_USER || '';
const password = process.env.INFLUXDB_PASSWORD || '';
const dataBaseName = 'position_data';
const measurement = 'positionDelay';

const sleep = time => new Promise(resolve => setTimeout(resolve, time));

const influx = new Influx.InfluxDB({
    host: influxServerIp,
    username: username,
    password: password,
    database: dataBaseName,
    schema: [
        {
            measurement: measurement,
            fields: {
                lat: Influx.FieldType.FLOAT,
                long: Influx.FieldType.FLOAT,
                delay: Influx.FieldType.INTEGER
            },
            tags: [
                'vehicle',
                'route',
                'trip',
                'ac',
                'wifi',
                'destination',
                'tripPattern',
                'type',
                'serviceType'
            ]
        }
    ]
});


/**
 * Parses values of request and state vars from html code of
 * echtzeit.swu.de
 *
 * @param htmlString
 * @returns {{requestId: string, stateId: string}}
 */
function parseIds(htmlString) {
    const regexRequest = /var request = (\d+);/gm;
    const regexState = /var state = (\d+);/gm;


    const requestId = regexRequest.exec(htmlString)[1];
    const stateId = regexState.exec(htmlString)[1];
    return {requestId: requestId, stateId: stateId};
}

/**
 * Calls "api" of echtzeit.swu.de, returns xml response
 *
 * @param stateId
 * @param requestId
 * @returns {Promise<void>}
 */
function callApi(stateId, requestId) {
    const options = {
        method: 'POST',
        uri: basePath + api,
        formData: {
            request: requestId,
            state: stateId
        },
        headers: {
            /* 'content-type': 'application/x-www-form-urlencoded' */ // Is set automatically
        }
    };
    return rp(options);
}


/**
 * Parses api response to array of json objects
 *
 * @param xmlGlump
 * @returns {string|SVGMarkerElement|string}
 */
function parseXml(xmlGlump) {
    const options = {
        attributeNamePrefix: "",
        //attrNodeName: "attr", //default is 'false'
        textNodeName: "#text",
        ignoreAttributes: false,
        ignoreNameSpace: false,
        allowBooleanAttributes: false,
        parseNodeValue: true,
        parseAttributeValue: true,
        trimValues: true,
        //cdataTagName: "__cdata", //default is 'false'
        //cdataPositionChar: "\\c",
        //localeRange: "", //To support non english character in tag/attribute values.
        parseTrueNumberOnly: false,
        attrValueProcessor: a => he.decode(a, {isAttributeValue: true}),//default is a=>a
        tagValueProcessor: a => he.decode(a) //default is a=>a
    };

    if (parser.validate(xmlGlump) === true) { //optional (it'll return an object in case it's not valid)
        const jsonObj = parser.parse(xmlGlump, options);
        //console.log(jsonObj.markers.marker);
        return jsonObj.markers.marker;
    }
}

/**
 * Converts schedule string, e.g., '+ 03:20' to seconds
 * @param schedule
 * @returns {number}
 */
function convertScheduleStringToSeconds(schedule) {
    /*
    schedule value can be
       a) 'ab: AB:CD' -> trip will start at specific time // filtered before
       b) '+ 03:30' -> trip is delayed hh:mm (default case)
       c) '- 03:20' -> trip is early hh:mm
       d) '00:00' -> trip is on time hh:mm
     */

    const regex = /^(\+|\-)?\s?(\d{2})\:(\d{2})/gm;
    let delayInSeconds = 0;

    const matches = regex.exec(schedule);

    // case d) special case: schedule is 00:00
    if (matches.length < 3) {
        return delayInSeconds;
    }

    // seconds
    delayInSeconds += parseInt(matches[3], 10);

    // minutes * 60 = seconds
    delayInSeconds += parseInt(matches[2], 10) * 60;

    //  if 'schedule' is a negative number, e.g., - 03:30 case c)
    if (matches[1] === '-') {
        delayInSeconds *= -1;
    }

    return delayInSeconds;
}

/**
 * Translates given vehicle type to English. If vehicle type is unknown
 * it returns untranslated type
 *
 * @param type
 * @returns {*}
 */
function translateVehicleType(type) {
    switch(type) {
        case 'Strab': return 'tram';
        case 'Bus': return 'bus';
        case 'Schienenschleifzug': return 'railgrinder';
        default: return type;
    }
}

/**
 * Hot fix for 'toto-bug': sometimes, geo location of swu api is shift to africa
 * @param ordinate
 */
function fixLocation(ordinate) {
    ordinate = parseFloat(ordinate);

    if (!Number.isNaN(ordinate)) {
        while(Math.round(ordinate) < 8.0) {
            ordinate *= 10.0;
        }
    }

    return ordinate;
}

async function main() {
    console.log('INFO: Running...');

    // check if database exists
    const names = await influx.getDatabaseNames();
    if (!names.includes(dataBaseName)) {
        await influx.createDatabase(dataBaseName);
    }


    while (true) {
        console.log('INFO: Job started');
        try {
            const htmlString = await rp(basePath);
            const ids = parseIds(htmlString);
            const xml = await callApi(ids.stateId, ids.requestId);
            const markers = parseXml(xml);

            // Parse all markers and write to influxDb
            await Promise.all(markers.map(marker => {
                let fields = {
                    lat: fixLocation(marker.lat),
                    long: fixLocation(marker.lng)
                };

                // add delay only if bus/tram is on its way
                if(!marker.schedule.startsWith('ab:')
                    && (marker.schedule.startsWith('+')
                        || marker.schedule.startsWith('-'))) {
                    fields.delay = convertScheduleStringToSeconds(marker.schedule);
                }

                let tags = {
                    vehicle: marker.fzg,
                    route: marker.linie,
                    trip: marker.uml,
                    ac: marker.ac === 'J',
                    wifi: marker.wifi === 'J',
                    //,
                    tripPattern: marker.fw,
                    type: translateVehicleType(marker.typ)
                    //serviceType: marker.vt
                };
                
                // Optional tags
                if (marker.ziel !== '') {
                    tags.destination = marker.ziel;
                }

                if (marker.vt !== '') {
                    tags.serviceType = marker.vt;
                }


                return influx.writePoints([{
                    measurement: measurement,
                    tags: tags,
                    fields: fields
                }]).catch(err => {
                    console.error(`Error saving data to InfluxDB! ${err.stack}`);
                    process.exit(1);
                });
            }));
            console.log(`INFO: Job successful: stored ${markers.length} markers`);
        } catch (e) {
            console.log("ERROR: ", e);
            process.exit(1);
        }
        await sleep(sleepTime);
    }
}

main();