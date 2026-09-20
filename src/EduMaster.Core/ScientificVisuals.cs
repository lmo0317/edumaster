using System.Text.Json.Nodes;
namespace EduMaster.Core;
public static class ScientificVisuals
{
    public const string DrawingInstructions="""
비커는 사각형 rect나 네모 polyline으로 대체하지 말고 전용 type="beaker", coordinates=[x,y,w,h,liquidLevel]을 사용한다. x,y는 외곽 좌상단, w,h는 전체 너비·높이, liquidLevel은 용액 높이 비율 0~1(빈 비커는 0)이다. 앱이 열린 타원 입구·주둥이·둥근 바닥·눈금·액면을 그린다. 비커 하나당 beaker 요소 하나만 쓰고 별도 rect 액체·입구 선을 겹쳐 그리지 않는다. 용액 라벨·온도·농도·부피는 비커 밖의 text에 놓는다. 실제 부피 비례가 주어지면 같은 크기 용기의 액면에 반영하고, 용기 크기나 높이 비례가 주어지지 않으면 liquidLevel=0.55의 개략도로 그리며 임의 눈금 숫자·용기 용량은 추가하지 않는다. fill="gray"를 사용한다.
그림이 필수인 문제는 visualRequirement="required"로 적고, 모든 필수 그림을 graph, diagrams 또는 drawings에 제공한다. 그림 참조만 적고 그림을 빼지 않는다. 시각 자료가 불필요한 글 문제만 visualRequirement="none"을 쓴다. 원본 이미지 자체는 기준 자료이며 변형 그림을 대신하지 않는다.
graph는 null 또는 {type:"line",title,xLabel,yLabel,xPoints:[숫자...],yPoints:[숫자...],annotations:[]}다. diagrams는 [{title,unit:"d",charges:[{name,position:숫자,sign:"+" 또는 "-" 또는 "unknown",forceDirection:"+x" 또는 "-x" 또는 "none"}]}]다. position은 unit의 배수이며 미지의 부호나 힘 방향을 정답에서 가져와 표시하지 않는다.
점전하는 diagrams에, 단일 데이터 곡선은 graph에 적는다. 기하 도형, 회로, 역학·광학·실험 배치, 다중 곡선 및 그 밖의 그림은 drawings=[{title:"(가)",width:1000,height:600,description:"그림의 주어진 관계 요약",elements:[...]}]로 제공한다. 제목·description·좌표·라벨 모두 새 문제의 조건과 일치해야 한다. 필수 그림이 여러 개면 빠짐없이 제공한다. 최대 6그림, 그림당 160요소다.
elements는 {type,coordinates:[숫자...],text:"",fontSize:26,dashed:false,fill:"none"} 형식이다. type과 coordinates 형식: line 또는 arrow=[x1,y1,x2,y2](arrow의 끝점에 화살촉), circle=[cx,cy,r], ellipse=[cx,cy,rx,ry], rect=[x,y,w,h], polyline 또는 polygon=[x1,y1,x2,y2,...], text=[x,y](text에 실제 라벨). fill은 none(투명), white(흰색), gray(용액 등 연한 회색) 중 하나이며 닫힌 도형에 적용한다. 좌상단이 (0,0), x는 오른쪽, y는 아래쪽이며 모든 요소가 width,height 안에 들어가야 한다. width는 1000, height는 200~1000을 사용한다. 글자는 선과 겹치지 않게 두고 fontSize는 18~40을 쓴다. 모든 주어진 수치·기호·점 이름·단위·방향·연결선을 넣되, 문제에서 구하는 미지수의 정답·힘 방향·부호를 그림에 미리 공개하지 않는다. 회로선의 접속/비접속, 도형의 위치·각도, 물체와 힘의 작용점, 그래프의 축·단위·곡선을 새 문제에 맞게 구분한다. 비커·실험 장치는 외곽선, 액면, 용액 채움, 온도·농도·부피 라벨, 가열 또는 첨가 화살표를 포함한다. URL, SVG, HTML, Markdown 이미지, LaTeX 명령을 출력하지 말고 그리기 요소를 제공한다. 그림이 없으면 drawings=[]이다.
""";
    public static object DrawingSchema()=>System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>("""
{"type":"array","maxItems":6,"items":{"type":"object","properties":{"title":{"type":"string"},"width":{"type":"number","enum":[1000]},"height":{"type":"number","minimum":200,"maximum":1000},"description":{"type":"string"},"elements":{"type":"array","minItems":1,"maxItems":160,"items":{"type":"object","properties":{"type":{"type":"string","enum":["beaker","line","arrow","circle","ellipse","rect","polyline","polygon","text"]},"coordinates":{"type":"array","minItems":2,"maxItems":200,"items":{"type":"number"}},"text":{"type":"string"},"fontSize":{"type":"number","minimum":10,"maximum":40},"dashed":{"type":"boolean"},"fill":{"type":"string","enum":["none","white","gray"]}},"required":["type","coordinates","text","fontSize","dashed","fill"]}}},"required":["title","width","height","description","elements"]}}
""");
    public static bool NeedsVisuals(string text)=>System.Text.RegularExpressions.Regex.IsMatch(text,@"그림|회로도|모식도|도식|배치도|도형|그래프",System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    public static bool HasVisuals(SampleResult result)=>result.Graph is not null||result.Diagrams.Length>0||result.Drawings.Length>0;
    public static void RequireVisuals(SampleResult result,bool sourceRequires=false){if((sourceRequires||result.RequiresVisuals||NeedsVisuals(result.Body))&&!HasVisuals(result))throw new InvalidDataException("변형 문제에 필요한 그림 데이터가 누락됐습니다. 그림 없는 결과는 완료로 표시하지 않습니다.");}
    public static ProblemDrawing[] ParseDrawings(JsonNode? value)
    {
        if(value is null)return [];
        if(value is not JsonArray array||array.Count>6)throw new InvalidDataException("그림 목록 형식이 잘못되었습니다.");
        return array.Select(item=>{
            if(item is not JsonObject scene)throw new InvalidDataException("그림 정보가 없습니다.");
            var title=scene["title"]?.GetValue<string>()??"";var description=scene["description"]?.GetValue<string>()??"";
            var width=scene["width"]?.GetValue<double>()??0;var height=scene["height"]?.GetValue<double>()??0;
            if(string.IsNullOrWhiteSpace(title)||title.Length>100||description.Length>2000||width!=1000||!double.IsFinite(height)||height is <200 or >1000||scene["elements"] is not JsonArray elements||elements.Count is <1 or >160)throw new InvalidDataException("그림의 크기·제목·요소를 확인해 주세요.");
            var parsed=elements.Select(element=>{
                if(element is not JsonObject e||e["coordinates"] is not JsonArray coordinates)throw new InvalidDataException("그림 요소의 좌표가 없습니다.");
                var type=e["type"]?.GetValue<string>()??"";var p=coordinates.Select(n=>n?.GetValue<double>()??double.NaN).ToArray();
                var text=e["text"]?.GetValue<string>()??"";var font=e["fontSize"]?.GetValue<double>()??26;var dashed=e["dashed"]?.GetValue<bool>()??false;var fill=e["fill"]?.GetValue<string>()??"white";
                if(fill is not("none" or "white" or "gray"))throw new InvalidDataException("그림의 채움 형식이 잘못되었습니다.");
                var valid=type switch{"beaker"=>p.Length==5,"line" or "arrow" or "rect" or "ellipse"=>p.Length==4,"circle"=>p.Length==3,"text"=>p.Length==2,"polyline"=>p.Length>=4&&p.Length<=200&&p.Length%2==0,"polygon"=>p.Length>=6&&p.Length<=200&&p.Length%2==0,_=>false};
                if(!valid||p.Any(v=>!double.IsFinite(v))||text.Length>200||!double.IsFinite(font)||font is <10 or >40||type=="text"&&string.IsNullOrWhiteSpace(text))throw new InvalidDataException("그림 요소의 형식·라벨·좌표가 잘못되었습니다.");
                bool Point(double x,double y)=>x>=0&&x<=width&&y>=0&&y<=height;
                valid=type switch{
                    "circle"=>p[2]>0&&Point(p[0]-p[2],p[1]-p[2])&&Point(p[0]+p[2],p[1]+p[2]),
                    "ellipse"=>p[2]>0&&p[3]>0&&Point(p[0]-p[2],p[1]-p[3])&&Point(p[0]+p[2],p[1]+p[3]),
                    "rect"=>p[2]>0&&p[3]>0&&Point(p[0],p[1])&&Point(p[0]+p[2],p[1]+p[3]),
                    "beaker"=>p[2]>0&&p[3]>0&&p[4]>=0&&p[4]<=1&&Point(p[0],p[1])&&Point(p[0]+p[2],p[1]+p[3]),
                    _=>Enumerable.Range(0,p.Length/2).All(i=>Point(p[2*i],p[2*i+1]))};
                if(!valid)throw new InvalidDataException("그림 요소가 캔버스 영역을 벗어났습니다.");
                if(type is "line" or "arrow"&&p[0]==p[2]&&p[1]==p[3])throw new InvalidDataException("그림 선·화살표의 시작점과 끝점이 같습니다.");
                return new DrawingElement(type,p,text,font,dashed,fill);
            }).ToArray();
            if(!parsed.Any(e=>e.Type!="text"))throw new InvalidDataException("그림에 라벨만 있고 실제 도형·선이 없습니다.");
            return new ProblemDrawing(title,width,height,description,parsed);
        }).ToArray();
    }
    public static ChargeDiagram[] ParseDiagrams(JsonNode? value)
    {
        if(value is null)return [];
        if(value is not JsonArray array||array.Count>4)throw new InvalidDataException("문제 모식도 형식이 잘못되었습니다.");
        return array.Select(item=>{
            if(item is not JsonObject diagram)throw new InvalidDataException("모식도 정보가 없습니다.");
            var title=diagram["title"]?.GetValue<string>()??"";var unit=diagram["unit"]?.GetValue<string>()??"";
            if(string.IsNullOrWhiteSpace(title)||title.Length>100||string.IsNullOrWhiteSpace(unit)||unit.Length>20||diagram["charges"] is not JsonArray charges||charges.Count is <2 or >12)throw new InvalidDataException("모식도의 제목·단위·전하를 확인해 주세요.");
            var parsed=charges.Select(c=>{
                var name=c?["name"]?.GetValue<string>()??"";var sign=c?["sign"]?.GetValue<string>()??"unknown";var direction=c?["forceDirection"]?.GetValue<string>()??"none";
                if(c?["position"] is null)throw new InvalidDataException("전하 위치가 누락되었습니다. 임의 위치로 그리지 않습니다.");
                var position=c["position"]!.GetValue<double>();
                if(string.IsNullOrWhiteSpace(name)||name.Length>30||!double.IsFinite(position)||Math.Abs(position)>1000||sign is not("+" or "-" or "unknown")||direction is not("+x" or "-x" or "none"))throw new InvalidDataException("전하 위치·부호·힘 방향이 잘못되었습니다.");
                return new DiagramCharge(name,position,sign,direction);
            }).ToArray();
            if(parsed.Select(c=>c.Name).Distinct().Count()!=parsed.Length||parsed.Select(c=>c.Position).Distinct().Count()!=parsed.Length)throw new InvalidDataException("전하 이름 또는 위치가 중복되었습니다.");
            return new ChargeDiagram(title,unit,parsed);
        }).ToArray();
    }
    public static ProblemGraph? ParseGraph(JsonNode? value)
    {
        if(value is null)return null;
        if(value is not JsonObject graph)throw new InvalidDataException("그래프 데이터 형식이 잘못되었습니다.");
        if(graph["type"]?.GetValue<string>() is string type&&type!="line")throw new InvalidDataException("데이터 곡선과 모식도를 구분해 주세요.");
        if(graph["xPoints"] is not JsonArray x||graph["yPoints"] is not JsonArray y||x.Count is <2 or >1000||x.Count!=y.Count)throw new InvalidDataException("그래프의 축 데이터가 누락되거나 서로 다릅니다.");
        var xs=x.Select(p=>p!.GetValue<double>()).ToArray();var ys=y.Select(p=>p!.GetValue<double>()).ToArray();
        if(xs.Any(p=>!double.IsFinite(p))||ys.Any(p=>!double.IsFinite(p)))throw new InvalidDataException("그래프 좌표가 유효하지 않습니다.");
        return new("line",graph["title"]?.GetValue<string>()??"자료 그래프",graph["xLabel"]?.GetValue<string>()??"x",graph["yLabel"]?.GetValue<string>()??"y",xs,ys,graph["annotations"]?.AsArray().Select(a=>a!.GetValue<string>()).ToArray());
    }
}
