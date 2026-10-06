export function calculateVolumeSpikeRatio(currentVolume: number, historicalVolumes: number[]): number {
  if (historicalVolumes.length === 0) return 1.0;
  const avgVolume = historicalVolumes.reduce((acc, v) => acc + v, 0) / historicalVolumes.length;
  if (avgVolume === 0) return 1.0;
  return Number((currentVolume / avgVolume).toFixed(2));
}
