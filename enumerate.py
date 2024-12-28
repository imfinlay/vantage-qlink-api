import requests
import csv

# API URL
API_URL = "http://localhost:3000"

# Output CSV file
OUTPUT_FILE = "vantage_data.csv"

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

        # Step 2: Use VQM command to list masters
        masters = send_command("VQM")
        
        # Prepare CSV headers
        csv_data = [("Master", "Module", "Station")]

        for master in masters:
            # Step 3: Use VQP command to list modules for each master
            modules = send_command(f"VQP {master}")

            for module in modules:
                # Step 4: Use VQS command to list stations for each module
                stations = send_command(f"VQS {module}")

                for station in stations:
                    csv_data.append((master, module, station))

        # Write results to CSV
        with open(OUTPUT_FILE, "w", newline="") as csvfile:
            writer = csv.writer(csvfile)
            writer.writerows(csv_data)

        print(f"Data successfully written to {OUTPUT_FILE}")

    except requests.RequestException as e:
        print(f"An error occurred: {e}")

    finally:
        # Disconnect from the server
        disconnect()

if __name__ == "__main__":
    main()

