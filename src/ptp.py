import time
import os
import subprocess
import re

def convert_value(value: str):
    """
    Converts a string to an integer.
    Supports hexadecimal values prefixed with '0x'.
    Returns the original value if conversion fails.
    """
    try:
        if value.lower().startswith("0x"):
            return int(value, 16)
        return int(value)
    except ValueError:
        return value

def get_pmc_data() -> dict:
    """
    Retrieves PTP default dataset values using the pmc command.
    Parses the output into a dictionary of key-value pairs.
    """
    data = {}
    output = get_ptp_default_dataset()
    for line in output.splitlines():
        match = re.match(r'^\s{2,}(\S+)\s+(\S+)', line)
        if match:
            key, value = match.groups()
            data[key] = convert_value(value)
    return data

def get_ptp_default_dataset():
    """
    Executes the pmc command to get the DEFAULT_DATA_SET from ptp4l.
    Uses UDS mode (-u) and no specific interface.
    """
    command = ['pmc', '-u', 'GET DEFAULT_DATA_SET']
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=True)
        output = result.stdout.strip()
        if not output:
            return "No output received. Please check your ptp4l configuration and synchronization status."
        return output
    except FileNotFoundError:
        return ("Error: 'pmc' command not found. "
                "Ensure the Linux PTP suite is installed and 'pmc' is in your PATH.")
    except subprocess.CalledProcessError as e:
        return f"Error executing command: {e.stderr}"

def open_ptp_device(device: str = '/dev/ptp0'):
    """
    Opens the PTP device and returns its file descriptor.
    """
    return os.open(device, os.O_RDWR)

def get_ptp_time(fd):
    """
    Reads the current PTP time from the given file descriptor.
    Returns the timestamp in microseconds.
    """
    # Calculate the clock ID as in the FD_TO_CLOCKID Glibc extension
    clock_id = ((~fd << 3) | 3)
    # Get the timestamp as float seconds
    timestamp = time.clock_gettime(clock_id)
    return round(timestamp * 1_000_000)

def get_rtp_time(fd, rtp_clock_rate: int = 48000, packet_time_ms: int = 1):
    """
    Converts the PTP timestamp to an RTP timestamp.
    rtp_clock_rate: clock rate of the RTP stream (e.g., 48000 Hz)
    packet_time_ms: duration of each packet in milliseconds
    """
    clock_id = ((~fd << 3) | 3)
    timestamp = int(time.clock_gettime(clock_id) * rtp_clock_rate)
    # Compute packet interval in timestamp units and round accordingly
    interval = rtp_clock_rate * packet_time_ms // 1000
    return int(round(timestamp / interval) * interval) & 0xffffffff
