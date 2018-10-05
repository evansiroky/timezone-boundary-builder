class ProgressStats {

    constructor(totalDownloads) {
        this.totalDownloads = totalDownloads
        this.downloadCounter = 0
        this.timestamps = []
    }

    logNext() {
        this.downloadCounter++
        this.timestamps.push({
            "index": this.downloadCounter,
            "timestamp": Date.now()
        })
    }

    /**
     * calculates the percentage of finished downloads
     * @returns {string}
     */
    getPercentage() {
        var current = (this.downloadCounter / this.totalDownloads)
        return Math.round(current * 1000.0) / 10.0
    }

    /**
     * calculates the time left and outputs it in human readable format
     * calculation is based on a reference length, that can be defined.
     *
     * @returns {string}
     */
    getTimeLeft(referenceLength) {
        if(this.downloadCounter <= referenceLength){
            //number of reference downloads must exist before left time can be predicted
            return "? minutes"
        }
        var processDurationInSeconds = (Date.now() - this.timestamps[0].timestamp) / 1000
        if(processDurationInSeconds < 60){
            //process must run longer than 60seconds before left time can be predicted
            return "? minutes"
        }

        var indexOfStepsBefore = this.timestamps.findIndex((t) => {
            return t.index == (this.downloadCounter - referenceLength)
        })
        var lastSteps = this.timestamps[indexOfStepsBefore];
        var millisOflastSteps = Date.now() - lastSteps.timestamp
        var downloadsLeft = this.totalDownloads - this.downloadCounter
        var millisecondsLeft = (millisOflastSteps / referenceLength) * downloadsLeft
        return this.formatMilliseconds(millisecondsLeft)
    }

    /**
     * inspired from https://stackoverflow.com/questions/19700283/how-to-convert-time-milliseconds-to-hours-min-sec-format-in-javascript
     * @param millisec
     * @returns {string}
     */
    formatMilliseconds(millisec) {
        var seconds = (millisec / 1000).toFixed(1);
        var minutes = (millisec / (1000 * 60)).toFixed(1);
        var hours = (millisec / (1000 * 60 * 60)).toFixed(1);
        var days = (millisec / (1000 * 60 * 60 * 24)).toFixed(1);
        if (seconds < 60) {
            return seconds + " seconds";
        } else if (minutes < 60) {
            return minutes + " minutes";
        } else if (hours < 24) {
            return hours + " hours";
        } else {
            return days + " days"
        }
    }

}

module.exports = ProgressStats