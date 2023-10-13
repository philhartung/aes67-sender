// execute with realtime scheduling
// sudo chrt -f 99 node aes67 --api ALSA -d 3
const os = require('os');
const ptpv2 = require('ptpv2');
const dgram = require('dgram');
const sdp = require('./lib/sdp');
const { Command } = require('commander');
const { RtAudio, RtAudioFormat, RtAudioApi } = require('audify');

//init udp client
const client = dgram.createSocket('udp4');

//command line options
const program = new Command();
program.version('1.0.0');
program.option('-v, --verbose', 'enable verbosity');
program.option('--devices', 'list audio devices');
program.option('-d, --device <index>', 'set audio device');
program.option('-m, --mcast <address>', 'multicast address of AES67 stream');
program.option('-n, --streamname <name>', 'name of AES67 stream');
program.option('-c, --channels <number>', 'number of channels');
program.option('-a, --api <api>', 'audio api (ALSA, OSS, PULSE, JACK, MACOS, ASIO, DS, WASAPI)');
program.option('--address <address>', 'IPv4 address of network interface');

program.parse(process.argv);

let logger = function(){};
if(program.verbose){
	logger = console.log;
}

//rtAudio api stuff
let rtAudio;
if(program.api){
	switch(program.api.toLowerCase()){
		case 'alsa':
			rtAudio = new RtAudio(RtAudioApi.LINUX_ALSA);
			break;
		case 'oss':
			rtAudio = new RtAudio(RtAudioApi.LINUX_OSS);
			break;
		case 'pulse':
			rtAudio = new RtAudio(RtAudioApi.LINUX_PULSE);
			break;
		case 'jack':
			rtAudio = new RtAudio(RtAudioApi.UNIX_JACK);
			break;
		case 'macos':
			rtAudio = new RtAudio(RtAudioApi.MACOSX_CORE);
			break;
		case 'asio':
			rtAudio = new RtAudio(RtAudioApi.WINDOWS_ASIO);
			break;
		case 'ds':
			rtAudio = new RtAudio(RtAudioApi.WINDOWS_DS);
			break;
		case 'wasapi':
			rtAudio = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
			break;
		default:
			rtAudio = new RtAudio();
	}
}else{
	rtAudio = new RtAudio();
}

logger('Selected',rtAudio.getApi(),'as audio api');

//list audio devices
let audioDevices = rtAudio.getDevices();
if(program.devices){
	console.log('Index, Name, # of Channels');
	for(let i = 0; i < audioDevices.length; i++){
		let device = audioDevices[i];
		
		if(device.inputChannels > 0){
			console.log(i, device.name, device.inputChannels);
		}
	}

	process.exit();
}

//options for AES67
//stream name
let streamName = os.hostname();
if(program.streamname){
	streamName = program.streamname;
}

//network addr
let addr;
if(program.address){
	addr = program.address;
	//check if IPv4????
}else{
	let interfaces = os.networkInterfaces();
	let interfaceNames = Object.keys(interfaces);
	let addresses = [];

	for(let i = 0; i < interfaceNames.length; i++){
		let interface = interfaces[interfaceNames[i]];
		for(let j = 0; j < interface.length; j++){
			if(interface[j].family == 'IPv4' && interface[j].address != '127.0.0.1'){
				addresses.push(interface[j].address);
			}
		}
	}

	if(addresses.length == 0){
		console.error('No network interface found!');
		process.exit();
	}

	addr = addresses[0];
	logger('Selected',addr ,'as network interface');
}

//audio device
let audioDevice = rtAudio.getDefaultInputDevice();
let audioChannels;
if(program.device){
	audioDevice = parseInt(program.device);
}

let selectedDevice = audioDevices[audioDevice];

if(selectedDevice && selectedDevice.inputChannels > 0){
	logger('Selected device', selectedDevice.name, 'with ' + selectedDevice.inputChannels + ' input channels');
	audioChannels = Math.min(8, selectedDevice.inputChannels);
}else{
	console.error('Invalid audio device!');
	process.exit();
}

if(program.channels && parseInt(program.channels) != NaN && parseInt(program.channels) <= audioChannels){
	audioChannels = parseInt(program.channels);
}

//mcast addr
let aes67Multicast = '239.69.'+addr.split('.').splice(2).join('.');
if(program.mcast){
	aes67Multicast = program.mcast;
}

logger('Selected '+aes67Multicast+' as RTP multicast address.');

// Add interface to multicast membership (otherwise the OS randomly selects an interface for the multicast traffic)
client.addMembership(aes67Multicast, addr);

//AES67 params (hardcoded)
const samplerate = 48000;
const ptime = 1;
const fpp = (samplerate / 1000) * ptime;
const encoding = 'L24';
const sessID = Math.round(Date.now() / 1000);
const sessVersion = sessID;
let ptpMaster;

//rtp vars
let seqNum = 0;
let timestampCalc = 0;
let ssrc = sessID % 0x100000000;

//timestamp offset stuff
let offsetSum = 0;
let count = 0;
let correctTimestamp = true;

//open audio stream
logger('Opening audio stream.');
rtAudio.openStream(null, {deviceId: audioDevice, nChannels: audioChannels, firstChannel: 0}, RtAudioFormat.RTAUDIO_SINT16, samplerate, fpp, streamName, pcm => rtpSend(pcm));
logger('Trying to sync to PTP master.');

//ptp sync timeout
setTimeout(function(){
	if(!ptpMaster){
		console.error('Could not sync to PTP master. Aborting.');
		process.exit();
	}
}, 10000);

//init PTP client
ptpv2.init(addr, 0, function(){
	ptpMaster = ptpv2.ptp_master();
	logger('Synced to', ptpMaster, 'successfully');

	//start audio and sdp
	logger('Starting SAP annoucements and audio stream.');
	rtAudio.start();
	sdp.start(addr, aes67Multicast, samplerate, audioChannels, encoding, streamName, sessID, sessVersion, ptpMaster);
});

//RTP implementation
let rtpSend = function(pcm){
	//convert L16 to L24
	let samples = pcm.length / 2;
	let l24 = Buffer.alloc(samples * 3);
	
	for(let i = 0; i < samples; i++){
		l24.writeUInt16BE(pcm.readUInt16LE(i * 2), i * 3);
	}
	
	//create RTP header and RTP buffer with header and pcm data
	let rtpHeader = Buffer.alloc(12);
	rtpHeader.writeUInt16BE((1 << 15) + 96, 0);// set version byte and add rtp payload type
	rtpHeader.writeUInt16BE(seqNum, 2);
	rtpHeader.writeUInt32BE(ssrc, 8);
	
	let rtpBuffer = Buffer.concat([rtpHeader, l24]);

	// timestamp correction stuff
	if(correctTimestamp){
		correctTimestamp = false;

		let ptpTime = ptpv2.ptp_time();
		let timestampRTP = ((ptpTime[0] * samplerate) + Math.round((ptpTime[1] * samplerate) / 1000000000)) % 0x100000000;
		timestampCalc = Math.floor(timestampRTP / fpp)*fpp;
	}
	
	//write timestamp
	rtpBuffer.writeUInt32BE(timestampCalc, 4);
	
	//send RTP packet
	client.send(rtpBuffer, 5004, aes67Multicast);	

	//timestamp average stuff
	let ptpTime = ptpv2.ptp_time();
	let timestampRTP = ((ptpTime[0] * samplerate) + Math.round((ptpTime[1] * samplerate) / 1000000000)) % 0x100000000;
	offsetSum += Math.abs(timestampRTP - timestampCalc);
	count++;

	//increase timestamp and seqnum
	seqNum = (seqNum + 1) % 0x10000;
	timestampCalc = (timestampCalc + fpp) % 0x100000000;
}

//Interval for timestamp correction calculation
setInterval(function(){
	let avg = Math.round(offsetSum / count);

	if(avg > fpp){
		correctTimestamp = true;
		let offsetMS = Math.round(avg / fpp * 1000) / 1000;
		logger('Resycing PTP and RTP timestamp. Offset was '+offsetMS+'ms.');
	}

	offsetSum = 0;
	count = 0;
}, 100);
