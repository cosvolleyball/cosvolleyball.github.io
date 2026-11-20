/**
 * Choose the next rotation from the people actually present/waiting.
 * Team count controls the bracket; playing format controls on-court size.
 * The organizer chooses freely from eligible formats; recommendations are
 * suggestions only, not rules.
 */
export function rotationOptions(availableCount, {privateEvent=false}={}) {
  if (!Number.isInteger(availableCount) || availableCount < 0)
    throw new RangeError("Available player count must be nonnegative.");
  const result=[];
  for(const teamCount of [4,5,6]) {
    const base=Math.floor(availableCount/teamCount);
    const extra=availableCount%teamCount;
    const sizes=Array.from({length:teamCount},(_,i)=>base+(i<extra?1:0));
    for(const format of [4,5,6]) {
      if (privateEvent && format===5) continue;
      if(teamCount===6) {
        // Two teams play and the third same-court team can volunteer
        // temporary substitutes; the team itself must have at least four.
        if(base<4 || base*3<2*format) continue;
      }else if(base<format)continue;
      const majorityCanField=format<=base;
      const oneShortWithMajority=teamCount===6&&format===base+1&&extra>=teamCount-1;
      const recommended=majorityCanField || oneShortWithMajority;
      result.push({
        teamCount,format,sizes,
        recommended,
        needsBorrowedSubs:teamCount===6&&base<format,
        summary:sizes.reduce((arr,size)=>{
          const last=arr.find(item=>item.size===size);
          if(last)last.count++;
          else arr.push({size,count:1});
          return arr;
        },[]).sort((a,b)=>a.size-b.size).map(({size,count})=>
          count+" team"+(count===1?"":"s")+" of "+size).join(" · ")
      });
    }
  }
  return result;
}
