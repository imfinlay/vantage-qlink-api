import requests
import csv
import time

# Configuration
API_URL = "http://localhost:3000"  # Change if API runs on a different address or port
SERVER_INDEX = 1  # Index of the server to connect to
OUTPUT_CSV = "vantage_results.csv"

def connect_to_server():
    response = requests.post(f"{API_URL}/connect", json={"serverIndex": SERVER_INDEX})
    response.raise_for_status()
    print(response.json()["message"])

def disconnect_from_server():
    response = requests.post(f"{API_URL}/disconnect")
    response.raise_for_status()
    print(response.json()["message"])

def send_command(command):
    response = requests.post(f"{API_URL}/send", json={"message": command})
    response.raise_for_status()
    return response.json()["response"]

def parse_response(response):
    # Assuming responses are comma-separated; adjust parsing logic if needed
    return [item.strip() for item in response.split(",")]

def main():
    try:
        # Connect to the server
        connect_to_server()

        # Step 2: Use VQM to list masters
        masters_response = send_command("VQM")
        masters = parse_response(masters_response)
        print("Masters:", masters)

        results = []

        # Step 3: For each master, use VQP to list modules
        for master in masters:
            modules_response = send_command(f"VQP {master}")
            modules = parse_response(modules_response)
            print(f"Modules for master {master}:", modules)

            # Step 4: For each module, use VQS to list stations
            for module in modules:
                stations_response = send_command(f"VQS {module}")
                stations = parse_response(stations_response)
                print(f"Stations for module {module}:", stations)

                # Add to results
                for station in stations:
                    results.append({"Master": master, "Module": module, "Station": station})

        # Write results to CSV
        with open(OUTPUT_CSV, mode="w", newline="") as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=["Master", "Module", "Station"])
            writer.writeheader()
            writer.writerows(results)

        print(f"Results saved to {OUTPUT_CSV}")

    except requests.exceptions.RequestException as e:
        print(f"Error: {e}")
    finally:
        # Ensure disconnection from the server
        disconnect_from_server()

if __name__ == "__main__":
    main()

