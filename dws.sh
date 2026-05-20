#!/bin/bash

# ==============================================================================
# DWS Calendar Mode Availability Search Script
# Target: H200 (A3 Ultra) GPUs - a3-ultragpu-8g
# API: REST advice.calendarMode (Regional availability check)
# ==============================================================================

# Verify input for nodes
if [ -z "$1" ]; then
  echo "Usage: $0 <number_of_nodes> [duration_in_days]"
  echo "Example: $0 4 7"
  exit 1
fi

NODES=$1
DAYS=$2

# Prompt for duration if not provided as the second argument
if [ -z "$DAYS" ]; then
  read -p "Enter reservation duration in days (e.g., 1, 7, 30): " DAYS
fi

# Validate that the duration is a number
if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
   echo "Error: Duration must be a positive integer representing days."
   exit 1
fi

# Convert days to seconds, formatted for the API (e.g., 7 days = "604800s")
DURATION="$((DAYS * 86400))s"
MACHINE_TYPE="a3-ultragpu-8g"

# Ensure gcloud CLI is configured
PROJECT_ID=$(gcloud config get-value project 2>/dev/null)

if [ -z "$PROJECT_ID" ]; then
    echo "Error: No Google Cloud project is set. Run 'gcloud config set project YOUR_PROJECT_ID'"
    exit 1
fi

# Grab the token
TOKEN=$(gcloud auth print-access-token)

# Safeguard: Ensure the token was successfully generated
if [ -z "$TOKEN" ]; then
    echo ""
    echo "================================================================="
    echo " ERROR: Could not retrieve a valid OAuth access token."
    echo " Your gcloud session may be expired or missing permissions."
    echo " Please run: gcloud auth login"
    echo "================================================================="
    exit 1
fi

if ! command -v jq &> /dev/null; then
    echo "Error: 'jq' is not installed. Please install it to parse the JSON response."
    exit 1
fi

# Calculate Timeframes 
# START_TIME: +88 hours from now (safely clears the +87 hour minimum requirement)
# END_TIME: +60 days from now (maximum visibility window for DWS)
START_TIME=$(python3 -c "from datetime import datetime, timedelta; print((datetime.utcnow() + timedelta(hours=88)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
END_TIME=$(python3 -c "from datetime import datetime, timedelta; print((datetime.utcnow() + timedelta(days=60)).strftime('%Y-%m-%dT%H:%M:%SZ'))")

echo "================================================================="
echo " Searching GCP Regions for DWS Calendar Mode Capacity"
echo " Target:        $NODES node(s) of $MACHINE_TYPE (H200)"
echo " Project:       $PROJECT_ID"
echo " Duration:      $DAYS day(s) ($DURATION)"
echo " Search Window: $START_TIME to $END_TIME"
echo "================================================================="

# Fetch all available Google Cloud regions
REGIONS=$(gcloud compute regions list --format="value(name)")

for REGION in $REGIONS; do
  echo -ne "Checking region: \033[1;34m$REGION\033[0m ... "
  
  # POST request to the regional advice.calendarMode API
  RESPONSE=$(curl -s -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    "https://compute.googleapis.com/compute/v1/projects/$PROJECT_ID/regions/$REGION/advice/calendarMode" \
    -d '{
      "futureResourcesSpecs": {
        "capacity-request": {
          "timeRangeSpec": {
            "startTimeNotEarlierThan": "'$START_TIME'",
            "startTimeNotLaterThan": "'$END_TIME'",
            "minDuration": "'$DURATION'",
            "maxDuration": "'$DURATION'"
          },
          "targetResources": {
            "specificSkuResources": {
              "machineType": "'$MACHINE_TYPE'",
              "instanceCount": "'$NODES'"
            }
          }
        }
      }
    }')
    
    # Validate the REST response for errors or unsupported regions
    HAS_ERROR=$(echo "$RESPONSE" | jq -r '.error // empty')
    
    if [ -n "$HAS_ERROR" ]; then
      ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error.message')
      echo -e "\033[0;31m[Not Supported / Error]\033[0m $ERROR_MSG"
    else
      # Check if capacity recommendations were returned
      RECOMMENDATIONS=$(echo "$RESPONSE" | jq -e '.recommendations' 2>/dev/null)
      
      if [ -n "$RECOMMENDATIONS" ] && [ "$RECOMMENDATIONS" != "null" ]; then
         
         # Extract the earliest start date out of all the returned options
         EARLIEST_START=$(echo "$RESPONSE" | jq -r '
            [ .recommendations[] | .recommendationsPerSpec[]? | .startTime ] 
            | min 
            | select(. != null)
         ')
         
         if [ -n "$EARLIEST_START" ]; then
             echo -e "\033[0;32m[CAPACITY AVAILABLE!]\033[0m"
             echo -e "   -> Earliest Available Date: \033[1;36m$EARLIEST_START\033[0m"
         else
             echo -e "\033[0;33m[No Capacity]\033[0m Region supports DWS Calendar mode, but no capacity was found."
         fi
         
      else
         echo -e "\033[0;33m[No Capacity]\033[0m Region supports DWS Calendar mode, but no capacity was found between $START_TIME and $END_TIME."
      fi
    fi
done

echo "================================================================="
echo "Search Complete."