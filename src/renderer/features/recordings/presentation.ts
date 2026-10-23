export function newRecordingFilename(date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, '0')
  const day = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-')
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join('-')
  return `EmCorder_${day}_${time}.mp4`
}

export function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    '',
  )
}
