var dgram = require('dgram');
var socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

var constructSDPMsg = function(addr, multicastAddr, samplerate, channels, encoding, name, sessID, sessVersion, ptpMaster){
	var sapHeader = Buffer.alloc(8);
	var sapContentType = Buffer.from('application/sdp\0');
	var ip = addr.split('.');

	//write version/options
	sapHeader.writeUInt8(0x20);

	//write hash
	sapHeader.writeUInt16LE(0xefef, 2);

	//write ip
	sapHeader.writeUInt8(parseInt(ip[0]), 4);
	sapHeader.writeUInt8(parseInt(ip[1]), 5);
	sapHeader.writeUInt8(parseInt(ip[2]), 6);
	sapHeader.writeUInt8(parseInt(ip[3]), 7);

	var sdpConfig = [
		'v=0',
		'o=- '+sessID+' '+sessVersion+' IN IP4 '+addr,
		's='+name,
		'c=IN IP4 '+multicastAddr+'/32',
		't=0 0',
		'a=clock-domain:PTPv2 0',
		'm=audio 5004 RTP/AVP 96',
		'a=rtpmap:96 '+encoding+'/'+samplerate+'/'+channels,
		'a=sync-time:0',
		'a=framecount:48',
		'a=ptime:1',
		'a=mediaclk:direct=0',
		'a=ts-refclk:ptp=IEEE1588-2008:'+ptpMaster,
		'a=recvonly',
		''
	];

	var sdpBody = Buffer.from(sdpConfig.join('\r\n'));

	return Buffer.concat([sapHeader, sapContentType, sdpBody]);
}

exports.start = function(addr, multicastAddr, samplerate, channels, encoding, name, sessID, sessVersion, ptpMaster){
	sdpMSG = constructSDPMsg(addr, multicastAddr, samplerate, channels, encoding, name, sessID, sessVersion, ptpMaster);

	socket.bind(9875, function(){
		socket.setMulticastInterface(addr);
		socket.send(sdpMSG, 9875, '239.255.255.255', function(err){});
	});
	
	setInterval(function(){
		socket.send(sdpMSG, 9875, '239.255.255.255', function(err){});
	}, 30*1000);
}
