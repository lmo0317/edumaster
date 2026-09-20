using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using EduMaster.Core;
namespace EduMaster.Core.Tests;
public class GeneralDrawingTests
{
    private const string Triangle="""
[{"title":"직각삼각형 ABC","width":1000,"height":600,"description":"AB=6, BC=8, ∠B=90°","elements":[{"type":"polygon","coordinates":[100,100,100,500,700,500]},{"type":"text","coordinates":[60,80],"text":"A"},{"type":"text","coordinates":[60,530],"text":"B"},{"type":"text","coordinates":[710,530],"text":"C"},{"type":"text","coordinates":[55,300],"text":"6"},{"type":"text","coordinates":[400,550],"text":"8"},{"type":"text","coordinates":[430,280],"text":"x"}]}]
""";
    [Fact]public void GeneralGeometryKeepsAllCoordinatesAndUnknownLabel(){var drawing=Assert.Single(ScientificVisuals.ParseDrawings(JsonNode.Parse(Triangle)));Assert.Equal(7,drawing.Elements.Length);Assert.Equal("x",drawing.Elements[^1].Text);Assert.Equal(700,drawing.Elements[0].Coordinates[4]);}
    [Theory][InlineData(0)][InlineData(0.55)][InlineData(1)]public void BeakerRetainsExplicitLiquidLevel(double level){var node=JsonNode.Parse(Triangle)!;node[0]!["elements"]![0]!["type"]="beaker";node[0]!["elements"]![0]!["coordinates"]=JsonSerializer.SerializeToNode(new[]{100d,100,180,300,level});var drawing=Assert.Single(ScientificVisuals.ParseDrawings(node));Assert.Equal("beaker",drawing.Elements[0].Type);Assert.Equal(level,drawing.Elements[0].Coordinates[4]);}
    [Theory][InlineData(-0.1)][InlineData(1.1)]public void ImpossibleLiquidLevelIsRejected(double level){var node=JsonNode.Parse(Triangle)!;node[0]!["elements"]![0]!["type"]="beaker";node[0]!["elements"]![0]!["coordinates"]=JsonSerializer.SerializeToNode(new[]{100d,100,180,300,level});Assert.Throws<InvalidDataException>(()=>ScientificVisuals.ParseDrawings(node));}
    [Theory][InlineData("polygon",new double[]{0,0,10,10})][InlineData("image",new double[]{0,0})][InlineData("circle",new double[]{990,300,30})][InlineData("arrow",new double[]{100,100,1100,400})]
    public void MalformedUnsupportedOrClippedElementsAreRejected(string type,double[] coordinates){var node=JsonNode.Parse(Triangle)!;node[0]!["elements"]![0]!["type"]=type;node[0]!["elements"]![0]!["coordinates"]=JsonSerializer.SerializeToNode(coordinates);Assert.Throws<InvalidDataException>(()=>ScientificVisuals.ParseDrawings(node));}
    [Fact]public void LabelsAloneCannotPretendToBeDrawing(){var node=JsonNode.Parse(Triangle)!;node[0]!["elements"]!.AsArray().RemoveAt(0);Assert.Throws<InvalidDataException>(()=>ScientificVisuals.ParseDrawings(node));}
    [Fact]public void RequiredPictureCannotBeCompletedWithoutData(){var r=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"f","test","그림의 직각삼각형을 이용하시오.",["1","2","3","4","5"],"③ 3","explanation",["1","2","3"],"changed");Assert.Throws<InvalidDataException>(()=>ScientificVisuals.RequireVisuals(r));ScientificVisuals.RequireVisuals(r with{Drawings=ScientificVisuals.ParseDrawings(JsonNode.Parse(Triangle))});}
    [Fact]public async Task MissingRequiredDrawingIsRepairedOnceWithoutChangingVariantOrAnswer(){
        var draft=new ProblemDraft{Title="직각삼각형",Body="그림에서 ∠B=90°, AB=3, BC=4인 삼각형 ABC의 AC를 구하시오."};var calls=0;
        using var http=new HttpClient(new Handler(async request=>{
            using var payload=JsonDocument.Parse(await request.Content!.ReadAsStringAsync());calls++;
            if(calls==1)return Envelope(new{status="ready",message="",inputFingerprint=draft.Fingerprint(),sourceLocation="기준 문제",title="직각삼각형 변형",body="그림에서 ∠B=90°, AB=6, BC=8인 삼각형 ABC의 AC의 길이는?",choices=new[]{"8","9","10","11","12"},answerText="10",explanation="AC²=6²+8²=100이므로 AC=10이다.",steps=new[]{"직각 확인","피타고라스 정리","제곱근 계산"},changeSummary="3,4→6,8",graph=(object?)null,diagrams=Array.Empty<object>(),drawings=Array.Empty<object>(),visualRequirement="required"});
            Assert.Equal(2,calls);var source=JsonNode.Parse(payload.RootElement.GetProperty("messages")[1].GetProperty("content").GetString()!)!;
            return Envelope(new{bodyFingerprint=source["bodyFingerprint"]!.GetValue<string>(),graph=(object?)null,diagrams=Array.Empty<object>(),drawings=JsonNode.Parse(Triangle)});
        }));
        var result=await new DeepSeekVisualGenerator(http).GenerateAsync(draft,"test-only-key");
        Assert.Equal(2,calls);Assert.Single(result.Drawings);Assert.Equal("③ 10",result.Answer);Assert.Contains("AB=6",result.Body);Assert.Contains("보완 API 1회",result.UsageSummary);
    }
    [Fact]public async Task RectangularBeakerIsReplacedWithoutChangingVariantOrAnswer(){
        var draft=new ProblemDraft{Title="비커",Body="그림은 비커에 물 10 mL가 담긴 모습이다. 물의 양은?"};var calls=0;
        object Scene(bool corrected)=>new[]{new{title="비커",width=1000,height=600,description="물 20 mL가 담긴 비커",elements=new[]{new{type=corrected?"beaker":"rect",coordinates=corrected?new[]{100d,100,180,300,.55}:new[]{100d,100,180,300},text="",fontSize=26,dashed=false,fill="gray"}}}};
        using var http=new HttpClient(new Handler(async request=>{
            calls++;if(calls==1)return Envelope(new{status="ready",inputFingerprint=draft.Fingerprint(),sourceLocation="기준 문제",title="비커 변형",body="그림은 비커에 물 20 mL가 담긴 모습이다. 물의 양은?",choices=new[]{"10 mL","20 mL","30 mL","40 mL","50 mL"},answerText="20 mL",explanation="주어진 물의 양은 20 mL이다.",steps=new[]{"비커 확인","부피 확인","20 mL 선택"},changeSummary="10→20 mL",graph=(object?)null,diagrams=Array.Empty<object>(),drawings=Scene(false),visualRequirement="required"});
            var payload=JsonNode.Parse(await request.Content!.ReadAsStringAsync())!;var source=JsonNode.Parse(payload["messages"]![1]!["content"]!.GetValue<string>())!;
            return Envelope(new{bodyFingerprint=source["bodyFingerprint"]!.GetValue<string>(),graph=(object?)null,diagrams=Array.Empty<object>(),drawings=Scene(true)});
        }));
        var result=await new DeepSeekVisualGenerator(http).GenerateAsync(draft,"test-only-key");Assert.Equal(2,calls);Assert.Equal("beaker",Assert.Single(Assert.Single(result.Drawings).Elements).Type);Assert.Equal("② 20 mL",result.Answer);Assert.Contains("물 20 mL",result.Body);
    }
    private static HttpResponseMessage Envelope(object value)=>new(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(new{choices=new[]{new{finish_reason="stop",message=new{content=JsonSerializer.Serialize(value)}}}}))};
    private sealed class Handler(Func<HttpRequestMessage,Task<HttpResponseMessage>> send):HttpMessageHandler{protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)=>send(request);}
}
