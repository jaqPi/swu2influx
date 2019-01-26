const rp = require('request-promise');
const parser = require('fast-xml-parser');
const he = require('he');
const Influx = require('influx');

const basePath = 'https://echtzeit.swu.de';
const api = '/php/phpsqlajax_genxml.php?src=gps';

const influxServerIp = '192.168.10.200';
const dataBaseName = 'position_data';
const measurement = 'position';

const sleep = time => new Promise(resolve => setTimeout(resolve, time));

const influx = new Influx.InfluxDB({
    host: influxServerIp,
    database: dataBaseName,
    schema: [
        {
            measurement: measurement,
            fields: {
                vehicle: Influx.FieldType.INTEGER,
                route: Influx.FieldType.INTEGER,
                trip: Influx.FieldType.INTEGER,
                lat: Influx.FieldType.FLOAT,
                long: Influx.FieldType.FLOAT,
                ac: Influx.FieldType.BOOLEAN,
                wifi: Influx.FieldType.BOOLEAN,
                delay: Influx.FieldType.INTEGER,
                destination: Influx.FieldType.STRING,
                tripPattern: Influx.FieldType.INTEGER,
                typ: Influx.FieldType.STRING
            },
            tags: []
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

function convertScheduleStringToSeconds(schedule) {
    /*
    schedule value can be
       a) 'ab: AB:CD' -> trip will start at specific time
       b) '+ 03:30' -> trip is delayed hh:mm
       c) '- 03:20' -> trip is early hh:mm
       d) '00:00' -> trip is on time hh:mm
     */

    const regex = /^(\+|\-)?\s?(\d{2})\:(\d{2})/gm;

    let delayInSeconds = 0;
    if (schedule.startsWith('ab:')) {
        return delayInSeconds;
    }

    const matches = regex.exec(schedule);

    // special case: schedule is 00:00
    if (matches.length < 3) {
        return delayInSeconds;
    }


    delayInSeconds += parseInt(matches[3], 10);
    delayInSeconds += parseInt(matches[2], 10) * 60;

    // if 'schedule' is a negative number
    if (matches[1] === '-') {
        delayInSeconds *= -1;
    }

    return delayInSeconds;
}

async function main() {
    const names = await influx.getDatabaseNames();
    if (!names.includes(dataBaseName)) {
        await influx.createDatabase(dataBaseName);
    }

    while (true) {
        try {
            const htmlString = await rp(basePath);
            const ids = parseIds(htmlString);
            const xml = await callApi(ids.stateId, ids.requestId);
            const markers = parseXml(xml);

            await Promise.all(markers.map(marker => influx.writePoints([{
                measurement: measurement,
                tags: {},
                fields: {
                    vehicle: marker.fzg,
                    route: marker.linie,
                    trip: marker.uml,
                    lat: marker.lat,
                    long: marker.lng,
                    ac: marker.ac === 'J',
                    wifi: marker.wifi === 'J',
                    delay: convertScheduleStringToSeconds(marker.schedule),
                    destination: marker.ziel,
                    tripPattern: marker.fw,
                    typ: marker.typ
                }
            }]).catch(err => console.error(`Error saving data to InfluxDB! ${err.stack}`))));

        } catch (e) {
            console.log("ERROR: ", e);
        }
        await sleep(10000);
    }
}

main();

/*
// load html of echtzeit.swu.de to parse request and state vars
rp(basePath)
// extract request and state vars, required for api request
    .then((htmlString) => {
        return new Promise((resolve, reject) => {
            const requestId = regexRequest.exec(htmlString)[1];
            const stateId = regexState.exec(htmlString)[1];
            resolve({stateId: stateId, requestId: requestId});
        });
    })
    // call API by posting state and request vars
    .then((data) => {
        return new Promise((resolve, reject) => {
                rp()
                    .then((body) => {
                        resolve(body);
                    });

        });
    })
    // parse api response
    .then(body => {
        var options = {
            attributeNamePrefix : "",
            //attrNodeName: "attr", //default is 'false'
            textNodeName : "#text",
            ignoreAttributes : false,
            ignoreNameSpace : false,
            allowBooleanAttributes : false,
            parseNodeValue : true,
            parseAttributeValue : true,
            trimValues: true,
            //cdataTagName: "__cdata", //default is 'false'
            //cdataPositionChar: "\\c",
            //localeRange: "", //To support non english character in tag/attribute values.
            parseTrueNumberOnly: false,
            attrValueProcessor: a => he.decode(a, {isAttributeValue: true}),//default is a=>a
            tagValueProcessor : a => he.decode(a) //default is a=>a
        };

        if( parser.validate(body) === true) { //optional (it'll return an object in case it's not valid)
            var jsonObj = parser.parse(body, options);
            console.log(jsonObj.markers.marker);
        }

        return new Promise(resolve => {
           resolve(jsonObj.markers.marker);
        });
    })
    .then(markers => {

    });
*/
/*request(basePath, function (error, response, body) {
    console.log('error:', error); // Print the error if one occurred
    console.log('statusCode:', response && response.statusCode); // Print the response status code if a response was received
    //console.log('body:', body); // Print the HTML for the Google homepage.
    requestId = regexRequest.exec(body)[1];
    stateId = regexState.exec(body)[1];
    console.log(requestId);
    console.log(stateId);
});

request.post({url:basePath + api, form: {request: requestId, state:stateId}}, function(err,response,body){
    console.log("huhu");
    console.log('error:', err); // Print the error if one occurred
    console.log('statusCode:', response && response.statusCode); // Print the response status code if a response was received
    console.log('body:', body); // Print the HTML for the Google homepage.
});
*/

/**
 * <script type="text/javascript">
 var request = 14462840970;
 var state = 1548453720;
 </script>
 **/