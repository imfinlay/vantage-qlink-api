import requests
import csv
import time

# API URL
API_URL = "http://localhost:3000"

# Output CSV file
OUTPUT_FILE = "vantage_data.csv"

# Configurable delay (in seconds)
CONNECT_DELAY = 3

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
    try:
        # Step 1: Get server list and connect to the first server
        servers = get_servers()
        if not servers:
            print("No servers available.")
            return

        connect_to_server(1)  # Connect to the first server

        # Send the "VCL 1 0" command after connecting
        vcl_response = send_command("VCL 1")

        # Check that the response is "1 0"
        if vcl_response.strip() != "1 0":
            print(f"Unexpected response to VCL command: {vcl_response}")
            return

        # Delay before sending the VQM command
        time.sleep(CONNECT_DELAY)

        # Step 2: Use VQM command to list masters
        command = "VQM"
        vqm_response = send_command(command)

        # Debug step: Print the command and the response
        print(f"Command sent: {command}")
        print(f"Response received: {vqm_response}")

        # Parse VQM response
        if isinstance(vqm_response, list):
            vqm_response = " ".join(vqm_response)  # Join list into a single string if it's a list

        master_addresses = vqm_response.split()
        if not master_addresses:
            print("No masters found.")
            return

        num_masters = int(master_addresses[0])  # First value is the number of masters
        master_list = master_addresses[1:]  # Subsequent values are the master addresses

        if len(master_list) != num_masters:
            print("Mismatch between reported number of masters and actual data.")
            return

        # Prepare CSV headers
        csv_data = [
            ("Master", "Station", "Station Type", "Config", "Version", "6-Bit", "Serial No")
        ]

        for master in master_list:
            # Step 3: Use VQS command to list stations for each master
            stations_response = send_command(f"VQS {master}")
            
            # Parse VQS response
            if isinstance(stations_response, list):
                stations_response = "\n".join(stations_response)  # Join list into string with newlines if needed

            station_lines = stations_response.splitlines()
            num_stations = int(station_lines[0])  # First line indicates the number of stations
            station_lines = station_lines[1:num_stations + 1]  # Extract station lines

            for station_line in station_lines:
                # Each line format: <master> <station> <type> <cfg> <ver> <6-bit> <serial no>
                station_parts = station_line.split()
                if len(station_parts) != 7:
                    print(f"Unexpected format in VQS response line: {station_line}")
                    continue

                _, station, station_type, config, station_version, bit6, serial_no = station_parts
                csv_data.append(
                    (master, station, station_type, config, station_version, bit6, serial_no)
                )

        # Write results to CSV
        with open(OUTPUT_FILE, "w", newline="") as csvfile:
            writer = csv.writer(csvfile)
            writer.writerows(csv_data)

        print(f"Data successfully written to {OUTPUT_FILE}")

    except requests.RequestException as e:
        if e.response is not None:
            print(f"Server responded with: {e.response.text}")
        print(f"An error occurred: {e}")

    finally:
        # Disconnect from the server
        disconnect()

if __name__ == "__main__":
    main()
