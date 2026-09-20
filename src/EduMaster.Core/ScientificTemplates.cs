using System.Text.Json.Nodes;
namespace EduMaster.Core;

public sealed record BeakerVessel(string Label,string[] Labels,double LiquidLevel);
public sealed record BeakerTemplate(string Type,string Title,BeakerVessel[] Containers,string TransitionLabel);

public static class ScientificTemplates
{
    public const string Version="scientific-templates-v1";
    public const string Instructions="""
비커 그림은 자유 좌표 drawings 대신 visualTemplates를 우선 사용한다.
visualTemplates=[{type:"beaker-sequence",title:"수용액 실험",containers:[{label:"(가)",labels:["2 M NaOH","25℃"],liquidLevel:0.55},{label:"(나)",labels:["50℃"],liquidLevel:0.55}],transitionLabel:"가열"}].
containers는 1~4개, label은 실제 용기 이름, labels는 주어진 농도·온도·부피·물질만이다. 모르는 값·정답을 라벨에 넣지 않는다. 액면의 높이 관계가 주어지지 않으면 0.55의 개략도를 쓰며 실제 부피 비례라고 주장하지 않는다. 같은 비커를 drawings에 다시 넣지 않는다. 앱이 외곽선·액면·간격·라벨 배치·화살표를 정한다. transitionLabel은 실제 과정만, 과정이 없으면 빈 문자열이다. 관련 없는 그림에는 visualTemplates=[]를 쓴다. 점전하 diagrams, 자료 곡선 graph는 기존 전용 템플릿을 사용한다.
""";
    public static object Schema()=>System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>("""
{"type":"array","maxItems":3,"items":{"type":"object","properties":{"type":{"type":"string","enum":["beaker-sequence"]},"title":{"type":"string"},"transitionLabel":{"type":"string"},"containers":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"object","properties":{"label":{"type":"string"},"labels":{"type":"array","maxItems":6,"items":{"type":"string"}},"liquidLevel":{"type":"number","minimum":0,"maximum":1}},"required":["label","labels","liquidLevel"]}}},"required":["type","title","containers","transitionLabel"]}}
""");
    public static BeakerTemplate[] Parse(JsonNode? value)
    {
        if(value is null)return [];
        if(value is not JsonArray array||array.Count>3)throw new InvalidDataException("그림 템플릿 목록 형식이 잘못되었습니다.");
        return array.Select(n=>{
            if(n is not JsonObject o||o["type"]?.GetValue<string>()!="beaker-sequence"||o["containers"] is not JsonArray cs||cs.Count is <1 or >4)throw new InvalidDataException("비커 템플릿 유형·용기 수를 확인해 주세요.");
            var title=o["title"]?.GetValue<string>()??"";var transition=o["transitionLabel"]?.GetValue<string>()??"";
            var containers=cs.Select(c=>{
                var label=c?["label"]?.GetValue<string>()??"";var labels=c?["labels"]?.AsArray()?.Select(s=>s?.GetValue<string>()??"").ToArray()??[];var level=c?["liquidLevel"]?.GetValue<double>()??.55;
                if(string.IsNullOrWhiteSpace(label)||label.Sum(c=>c>127?1:.55)>8||labels.Length>6||labels.Any(s=>string.IsNullOrWhiteSpace(s)||s.Length>60)||!double.IsFinite(level)||level is <0 or >1)throw new InvalidDataException("비커 템플릿의 라벨·액면 값이 잘못되었습니다.");
                return new BeakerVessel(label,labels,level);
            }).ToArray();
            if(string.IsNullOrWhiteSpace(title)||title.Length>100||transition.Length>20||containers.Select(c=>c.Label).Distinct().Count()!=containers.Length)throw new InvalidDataException("그림 템플릿 제목·용기 이름을 확인해 주세요.");
            return new BeakerTemplate("beaker-sequence",title,containers,transition);
        }).ToArray();
    }
    public static ProblemDrawing Compile(BeakerTemplate template)
    {
        var elements=new List<DrawingElement>();int maxLines=0;
        for(var i=0;i<template.Containers.Length;i++){
            var c=template.Containers[i];double center=(i+.5)*1000/template.Containers.Length;
            elements.Add(new("beaker",[center-80,100,160,230,c.LiquidLevel],"",26,false,"gray"));
            elements.Add(new("text",[center-c.Label.Sum(ch=>ch>127?1:.55)*14,58],c.Label,28,false,"none"));
            var lines=c.Labels.SelectMany(Wrap).ToArray();maxLines=Math.Max(maxLines,lines.Length);
            for(var j=0;j<lines.Length;j++)elements.Add(new("text",[center-100,365+j*30],lines[j],24,false,"none"));
            if(i+1<template.Containers.Length&&!string.IsNullOrWhiteSpace(template.TransitionLabel)){
                var next=(i+1.5)*1000/template.Containers.Length;
                elements.Add(new("arrow",[center+95,215,next-95,215],"",26,false,"none"));
                elements.Add(new("text",[(center+next)/2-24,177],template.TransitionLabel,24,false,"none"));
            }
        }
        if(maxLines>20)throw new InvalidDataException("비커 라벨이 너무 깁니다. 주어진 값만 짧게 적어 주세요.");
        return new(template.Title,1000,Math.Max(440,395+maxLines*30),"전용 비커 템플릿 · 액면은 입력 비율의 개략도 · "+Version,elements.ToArray());
    }
    private static IEnumerable<string> Wrap(string text)
    {
        var line="";double width=0;
        foreach(var c in text){var w=c>127?1:.55;if(width+w>8){yield return line;line="";width=0;}line+=c;width+=w;}if(line.Length>0)yield return line;
    }
}
