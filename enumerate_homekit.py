import requests
import time
import json

# API URL
API_URL = "http://localhost:3000"

# Output JSON file for HomeKit
OUTPUT_FILE = "vantage_homekit.json"

# Configurable delay (in seconds)
CONNECT_DELAY = 3

# Example mapping function from Vantage station type to HomeKit service type
def map_station_type_to_homekit_service(station_type):
    # Update this mapping as needed for your real station types
    type_map = {
        "0": "Lightbulb",
        "1": "Switch",
        # Add more as needed
    }
    return type_map.get(station_type, "Outlet")

def get_servers():
    response = requests.get(f"{API_URL}/servers")
    response.raise_for_status()
    return response.json()

def connect_to_server(server_index):
    response = requests.post(f"{API_URL}/connect", json={"serverIndex": server_index})
    response.raise_for_status()
    print(response.json()["message"])

def send_command(command):
    response = requests.post(f"{API_URL}/send", json={"message": command})
    response.raise_for_status()
    return response.json()["response"]

def disconnect():
    response = requests.post(f"{API_URL}/disconnect")
    response.raise_for_status()
    print(response.json()["message"])

def main():
    accessories = []
    try:
        servers = get_servers()
        if not servers:
            print("No servers available.")
            return

        connect_to_server(1)

        vcl_response = send_command("VCL 1")
        if not isinstance(vcl_response, list) or vcl_response != ["1", "0"]:
            print(f"Unexpected response to VCL command: {vcl_response}")
            return

        time.sleep(CONNECT_DELAY)

        vqm_response = send_command("VQM")
        print(f"Command sent: VQM")
        print(f"Response received: {vqm_response}")

        if isinstance(vqm_response, list):
            vqm_response = " ".join(vqm_response)

        master_addresses = vqm_response.split()
        if not master_addresses:
            print("No masters found.")
            return

        num_masters = int(master_addresses[0])
        master_list = master_addresses[1:]

        if len(master_list) != num_masters:
            print("Mismatch between reported number of masters and actual data.")
            return

        for master in master_list:
            stations_response = send_command(f"VQS {master}")
            if isinstance(stations_response, list):
                stations_response = "\n".join(stations_response)

            station_lines = stations_response.splitlines()
            num_stations = int(station_lines[0])
            station_lines = station_lines[1:]

            if len(station_lines) != num_stations:
                print(f"Mismatch in station count for master {master}. Expected {num_stations}, got {len(station_lines)}.")
                continue

            for station_line in station_lines:
                station_parts = station_line.split()
                if len(station_parts) != 7:
                    print(f"Unexpected format in VQS response line: {station_line}")
                    continue

                _, station, station_type, config, station_version, bit6, serial_no = station_parts

                # Map to HomeKit accessory format
                accessory = {
                    "name": f"Vantage Station {station}",
                    "manufacturer": "Vantage Controls",
                    "model": f"Qlink {station_version}",
                    "serialNumber": serial_no,
                    "master": master,
                    "station": station,
                    "type": map_station_type_to_homekit_service(station_type),
                    "services": [
                        {
                            "type": map_station_type_to_homekit_service(station_type),
                            "characteristics": [
                                {
                                    "type": "On",
                                    "value": False
                                }
                                # Add more characteristics as needed
                            ]
                        }
                    ]
                }
                accessories.append(accessory)

        # Write HomeKit accessories JSON
        with open(OUTPUT_FILE, "w") as jsonfile:
            json.dump(accessories, jsonfile, indent=2)

        print(f"Data successfully written to {OUTPUT_FILE}")

    except requests.RequestException as e:
        if e.response is not None:
            print(f"Server responded with: {e.response.text}")
        print(f"An error occurred: {e}")

    finally:
        disconnect()

if __name__ == "__main__":
    main()