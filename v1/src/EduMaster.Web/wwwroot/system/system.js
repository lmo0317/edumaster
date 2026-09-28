'use strict';
const apiBase=new URL('../api/',document.currentScript.src);
const access=sessionStorage.getItem('edumaster-access')||localStorage.getItem('edumaster-access')||'';
const deepseek=document.getElementById('deepseek-state'),gemma=document.getElementById('gemma-state');
if(!access){deepseek.textContent='설정 정보는 접속 후 확인할 수 있습니다.';gemma.textContent='현재 연결 여부는 접속 후 확인할 수 있습니다.';}
else fetch(new URL('status',apiBase),{headers:{Authorization:'Bearer '+access}}).then(response=>{if(!response.ok)throw new Error();return response.json();}).then(data=>{
 deepseek.textContent=data.deepseekConfigured?'서버에 설정됨 · 생성 모델로 선택 가능':'서버에 설정되지 않음';deepseek.className='state '+(data.deepseekConfigured?'ok':'off');
 gemma.textContent=data.gemmaAvailable?'현재 PC 연결됨 · 이미지 지원 확인':'현재 PC 연결 안 됨 · PC와 모델 서버가 켜져 있을 때 사용 가능';gemma.className='state '+(data.gemmaAvailable?'ok':'off');
}).catch(()=>{deepseek.textContent='현재 설정을 확인하지 못했습니다.';gemma.textContent='현재 연결 여부를 확인하지 못했습니다.';});
