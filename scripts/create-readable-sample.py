from PIL import Image,ImageDraw,ImageFont
from pathlib import Path
im=Image.new('RGB',(1200,1320),'white');d=ImageDraw.Draw(im)
font=lambda n,b=False:ImageFont.truetype('C:/Windows/Fonts/malgun'+('bd' if b else '')+'.ttf',n)
f=font(30);bold=font(32,True)
def text(x,y,t,ft=f):d.text((x,y),t,font=ft,fill='#111111')
text(60,45,'반응량 문제',font(38,True))
text(60,120,'다음은 A(g)와 B(g)가 반응하여 C(g)와 D(g)를 생성하는')
text(60,169,'반응의 화학 반응식이다.')
text(180,246,'A(g) + bB(g) → 2C(g) + 2D(g)',bold)
text(400,296,'(b는 반응 계수)')
text(60,377,'표는 실린더에 A(g)와 B(g)를 넣고 반응을 완결시킨')
text(60,426,'실험 I~III에 대한 자료이다.')
xs=[60,145,325,505,760,1140];ys=[510,660,750,840,930]
for x in xs:d.line((x,ys[0],x,ys[-1]),fill='#666666',width=2)
for y in ys:d.line((xs[0],y,xs[-1],y),fill='#666666',width=2)
headers=['실험','반응 전\nA의 질량(g)','반응 전\nB의 질량(g)','반응 후\nA 또는 B의\n질량(g)','반응 후\nD의 양(mol) /\n전체 기체의 양(mol)\n(상댓값)']
for j,h in enumerate(headers):
 ft=font(25);box=d.multiline_textbbox((0,0),h,font=ft,spacing=6);ww=box[2]-box[0];hh=box[3]-box[1];d.multiline_text(((xs[j]+xs[j+1]-ww)/2,520+(130-hh)/2),h,font=ft,fill='#111111',spacing=6,align='center')
rows=[['I','5w','5w','A (10/3)w','x'],['II','4w','6w','A 2w','18'],['III','2w','7w','B w','20']]
for i,row in enumerate(rows):
 for j,t in enumerate(row):text((xs[j]+xs[j+1]-d.textlength(t,font=f))/2,ys[i+1]+22,t)
text(60,986,'각 기체의 몰 질량(단위: g/mol)을 M_A, M_B, M_C, M_D라 할 때,',font(27))
text(60,1040,'(b/x) × (M_C + M_D) / M_B는?',font(34,True))
text(60,1105,'(단, 실린더 속 기체의 온도와 압력은 일정하다.)')
for j,t in enumerate(['① 1/5','② 2/5','③ 3/5','④ 4/5','⑤ 1']):text(75+j*222,1215,t,font(34))
p=Path('docs/참고자료/샘플자료/07_반응량_고해상도예시.png');im.save(p)
p=Path('src/EduMaster.Web/wwwroot/samples');im.save(p/'reaction-reconstructed.png')
print('Created reconstructed test fixture; PDF originals and default samples unchanged')
