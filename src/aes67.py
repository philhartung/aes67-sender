#!/usr/bin/env python3
import gi
import os
import socket
import struct
from ptp import open_ptp_device, get_rtp_time
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib

# Initialze GStreamer and PTP File Descriptor
Gst.init(None)
ptp_fd = open_ptp_device()

# --- Set up GStreamer Pipeline ---
pipeline_str = (
    "alsasrc device=hw:0,0 latency-time=1000 buffer-time=1000 ! audioconvert ! "
    "audio/x-raw,format=S24BE,channels=2,rate=48000 ! "
    "rtpL24pay pt=97 min-ptime=1000000 max-ptime=1000000 ! appsink name=sink"
)

pipeline = Gst.parse_launch(pipeline_str)
appsink = pipeline.get_by_name("sink")
# Enable asynchronous processing: activate signals so that new-sample callbacks are triggered
appsink.set_property("emit-signals", True)
appsink.set_property("sync", False)

# --- Configure UDP Socket for Multicast ---
multicast_addr = "239.69.123.11"  # Example multicast address
multicast_port = 5004             # Example port
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 32)

# The sample rate as defined by the pipeline (48000 Hz)
sample_rate = 48000

def new_sample_callback(sink):
    """
    Callback that is called for each new sample.
    It reads the RTP packet, replaces the timestamp in the header with the current PTP timestamp,
    and sends the modified packet via UDP to the multicast address.
    """
    sample = sink.emit("pull-sample")
    if not sample:
        return Gst.FlowReturn.ERROR

    buf = sample.get_buffer()
    success, map_info = buf.map(Gst.MapFlags.READ)
    if not success:
        return Gst.FlowReturn.ERROR

    packet = bytearray(map_info.data)
    buf.unmap(map_info)

    timestamp_source = get_rtp_time(ptp_fd)
    packet[4:8] = struct.pack("!I", timestamp_source)

    # Send packet via UDP to the multicast address
    sock.sendto(packet, (multicast_addr, multicast_port))

    return Gst.FlowReturn.OK

# Connect the "new-sample" signal to the callback
appsink.connect("new-sample", new_sample_callback)

# --- Start Pipeline and Run GLib Main Loop ---
pipeline.set_state(Gst.State.PLAYING)
main_loop = GLib.MainLoop()
try:
    main_loop.run()
except KeyboardInterrupt:
    main_loop.quit()
finally:
    pipeline.set_state(Gst.State.NULL)
    sock.close()
    os.close(ptp_fd)
