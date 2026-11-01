export function weightMatrix(scene,domain='',limit=128){
  const nodes=(scene?.nodes??[]).filter(n=>!domain||n.domainId===domain),index=new Map(nodes.map((n,i)=>[n.id,i]));
  const bins=Math.min(limit,nodes.length),cells=new Map();let count=0,max=0;
  for(const edge of scene?.edges??[]){if(!index.has(edge.source)||!index.has(edge.target))continue;count++;max=Math.max(max,Math.abs(edge.weight));const row=Math.floor(index.get(edge.source)/nodes.length*bins),column=Math.floor(index.get(edge.target)/nodes.length*bins),key=row*bins+column;const entry=cells.get(key)??{row,column,count:0,weight:0,edge:null};entry.count++;if(!entry.edge||Math.abs(edge.weight)>Math.abs(entry.weight)){entry.weight=edge.weight;entry.edge=edge;}cells.set(key,entry);}
  return{nodes,bins,cells,count,max};
}
export function potentialSeries(samples,node,outputs=null){
  if(!node)return[];
  const membrane=Object.values(outputs??{}).find(output=>output.id===node.id)?.membrane;
  return membrane??(samples??[]).map(sample=>({time:sample.time,value:sample.values.find(([id])=>id===node.id)?.[1]??node.restLevel}));
}
export function populationSeries(samples,nodes){if(!nodes.length)return[];const rest=new Map(nodes.map(node=>[node.id,node.restLevel])),baseline=nodes.reduce((sum,n)=>sum+n.restLevel,0);return(samples??[]).map(sample=>({time:sample.time,value:(baseline+sample.values.reduce((sum,[id,value])=>sum+(rest.has(id)?value-rest.get(id):0),0))/nodes.length}));}
