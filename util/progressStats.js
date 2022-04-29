class ProgressStats {
  constructor (trackerName, totalTasks) {
    this.trackerName = trackerName
    this.totalTasks = totalTasks
    this.taskCounter = 0
  }

  logNext () {
    this.taskCounter++
    if (!this.beginTime) {
      this.beginTime = new Date()
    }
  }

  /**
     * Begin a new task.  Print the current progress and then increment the number of tasks.
     * @param  {string}    A short message about the current task progress
     * @param  {[boolean]} logTimeLeft whether or not to log the time left.
     */
  beginTask (message, logTimeLeft) {
    this.printStats(message, logTimeLeft)
    this.logNext()
  }

  /**
     * Print the current progress.
     * @param  {string}    A short message about the current task progress
     * @param  {[boolean]} logTimeLeft whether or not to log the time left.
     */
  printStats (message, logTimeLeft) {
    message = `${message}; ${this.trackerName} progress: ${this.getPercentage()}% done`
    if (logTimeLeft) {
      message = `${message} - ${this.getTimeLeft()} left`
    }
    console.log(message)
  }

  /**
     * calculates the percentage of finished downloads
     * @returns {string}
     */
  getPercentage () {
    const current = (this.taskCounter / this.totalTasks)
    return Math.round(current * 1000.0) / 10.0
  }

  /**
     * calculates the time left and outputs it in human readable format
     * calculation is based on the average time per task so far
     *
     * @returns {string}
     */
  getTimeLeft () {
    if (this.taskCounter === 0) return '?'
    const averageTimePerTask = (Date.now() - this.beginTime.getTime()) / this.taskCounter
    const tasksLeft = this.totalTasks - this.taskCounter
    const millisecondsLeft = averageTimePerTask * tasksLeft
    return this.formatMilliseconds(millisecondsLeft)
  }

  /**
     * inspired from https://stackoverflow.com/questions/19700283/how-to-convert-time-milliseconds-to-hours-min-sec-format-in-javascript
     * @param millisec
     * @returns {string}
     */
  formatMilliseconds (millisec) {
    const seconds = (millisec / 1000).toFixed(1)
    const minutes = (millisec / (1000 * 60)).toFixed(1)
    const hours = (millisec / (1000 * 60 * 60)).toFixed(1)
    const days = (millisec / (1000 * 60 * 60 * 24)).toFixed(1)
    if (seconds < 60) {
      return seconds + ' seconds'
    } else if (minutes < 60) {
      return minutes + ' minutes'
    } else if (hours < 24) {
      return hours + ' hours'
    } else {
      return days + ' days'
    }
  }
}

module.exports = ProgressStats
