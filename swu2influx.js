const rp = require('request-promise');
const he = require('he');
const Influx = require('influx');
var notify;
try {
    notify = require('sd-notify')
} catch(e) {} // ignore

const basePath = 'https://echtzeit.swu.de';
const api = '/json/echtzjs.php?&src=gps';
const sleepTime = 15000;

const influxServerIp = process.env.INFLUXDB_HOST;
const username = process.env.INFLUXDB_USER || '';
const password = process.env.INFLUXDB_PASSWORD || '';
const dataBaseName = 'position_data';
const measurement = 'positionDelayV2';

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
                'type',
                'headsign',
                'activ'
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
       e) 'Oldtimer' -> or any other String...
     */

    const regex = /^(\+|\-)?\s?(\d{2})\:(\d{2})/gm;
    let delayInSeconds = 0;

    const matches = regex.exec(schedule);

    // case e) 'Oldtimer' is always on time because if you are on a ride with an oldtimer time does not matter
    // case d) special case: schedule is 00:00
    if (!matches || matches.length < 3) {
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
    console.info('Running...');

    // check if database exists
    let names;
    try {
        names = await influx.getDatabaseNames();
    }
    catch (e) {
        console.error(e);
        process.exit(1);
    }
    if (!names.includes(dataBaseName)) {
        await influx.createDatabase(dataBaseName);
    }

    try {
        notify.ready();
        const watchdogInterval = notify.watchdogInterval();
        if (watchdogInterval > 0) {
            const interval = Math.floor(watchdogInterval / 2);
            notify.startWatchdogMode(interval);
        }
    } catch(e) {}

    while (true) {
        console.info('Job started');
        try {
            const htmlString = await rp(basePath);
            const ids = parseIds(htmlString);
            const rawJson = await callApi(ids.stateId, ids.requestId);
            //const markers = parseXml(xml);
            const markers  = JSON.parse(rawJson);

            // Parse all markers and write to influxDb
            await Promise.all(markers.map(marker => {
                let fields = {
                    lat: fixLocation(marker.lat),
                    long: fixLocation(marker.lng)
                };

                // add delay only if bus/tram is on its way
                if(!marker.Abweichung.startsWith('ab:')) {
                    fields.delay = convertScheduleStringToSeconds(marker.Abweichung);
                }

                let tags = {
                    wifi: marker.Wifi === 'true',
                    type: translateVehicleType(marker.Typ),
                    active: marker.aktiv === 'true'
                };

                if(!isNaN(parseInt(marker.Fzg))) {
                    tags.vehicle = parseInt(marker.Fzg);
                }

                if(!isNaN(parseInt(marker.Linie))) {
                    tags.route = parseInt(marker.Linie);
                }

                if(!isNaN(parseInt(marker.TripID))) {
                    tags.trip = parseInt(marker.TripID);
                }


                // Optional tags
                if (marker.Zielschild !== '') {
                    tags.headsign = marker.Zielschild;
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
            console.info(`Job successful: stored ${markers.length} markers`);
        } catch (e) {
            console.error(e);
            process.exit(1);
        }
        await sleep(sleepTime);
    }
}

main();