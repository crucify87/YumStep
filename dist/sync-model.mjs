export const emptyState = () => ({recipes:[],saved:[],reviews:{},likes:[],profile:'나의 키친'});
export function recordsFor(state) {
  const records = new Map();
  const {recipes, reviews, ...settings} = state;
  records.set('settings', JSON.stringify(settings));
  for (const recipe of recipes) records.set('recipe-' + encodeURIComponent(recipe.id), JSON.stringify(recipe));
  for (const [id, values] of Object.entries(reviews)) values.forEach((value,index)=>records.set('review-' + encodeURIComponent(id) + '-' + String(index).padStart(8,'0'),JSON.stringify({id,index,value})));
  return records;
}
export function validateRecords(records) {
  for (const payload of records.values()) {
    if (new TextEncoder().encode(payload).length > 800000) {
      throw new Error('사진이 포함된 기록이 너무 큽니다. 데이터 파일로 백업한 뒤 사진 크기를 줄여 주세요. 이 기록은 브라우저에 보관됩니다.');
    }
  }
}
export function stateFor(records) {
  const state = emptyState();
  const reviews = [];
  for (const [key,payload] of records) {
    const value = JSON.parse(payload);
    if (key === 'settings') Object.assign(state, value);
    else if (key.startsWith('recipe-')) state.recipes.push(value);
    else if (key.startsWith('reviews-')) state.reviews[value.id] = value.values;
    else if (key.startsWith('review-')) reviews.push(value);
  }
  for(const {id,index,value} of reviews.sort((a,b)=>a.index-b.index)){state.reviews[id]??=[];state.reviews[id][index]=value;}
  return state;
}
export function batchEntries(records){
  const selected=[];let bytes=0;
  for(const entry of records){const size=new TextEncoder().encode(entry[1]).length;if(selected.length&&(selected.length>=400||bytes+size>6000000))break;selected.push(entry);bytes+=size;}
  return selected;
}
export function mergeGuest(account, guest) {
  const next = structuredClone(account);
  const ids = new Set(next.recipes.map(r=>r.id));
  for (const recipe of guest.recipes) if (!ids.has(recipe.id)) {next.recipes.push(recipe);ids.add(recipe.id);}
  next.saved = [...new Set([...next.saved,...guest.saved])];
  next.likes = [...new Set([...next.likes,...guest.likes])];
  for (const [id, values] of Object.entries(guest.reviews)) {
    const known = new Set((next.reviews[id] || []).map(v=>JSON.stringify(v)));
    next.reviews[id] ??= [];
    for (const value of values) if (!known.has(JSON.stringify(value))) {next.reviews[id].push(value);known.add(JSON.stringify(value));}
  }
  if(next.profile==='나의 키친')next.profile=guest.profile;
  if(!next.brandImage&&guest.brandImage)next.brandImage=guest.brandImage;
  return next;
}
