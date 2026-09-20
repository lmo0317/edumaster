using System.Net;
using System.Text;
using System.Text.Json;
using EduMaster.Core;
namespace EduMaster.Core.Tests;

public class LocalGemmaTests
{
    private static ProblemDraft Draft()=>new(){Title="열분해",Body="탄산칼슘 10 g을 완전히 분해한다. CaCO₃ → CaO + CO₂, CaCO₃ = 100 g/mol일 때 CO₂의 몰수는?"};
    private static object Variant(string source)=>new{status="ready",message="",changeSummary="10 g → 20 g",title="열분해 변형",body="탄산칼슘 20 g을 완전히 분해한다. CaCO₃ → CaO + CO₂, CaCO₃ = 100 g/mol일 때 CO₂의 몰수는?",choices=new[]{"0.05 mol","0.1 mol","0.2 mol","0.4 mol","1 mol"},answerIndex=2,answerText="0.2 mol",explanation="20/100 = 0.2 mol. 계수비 1:1이므로 CO₂도 0.2 mol이다.",steps=new[]{"몰질량 확인","몰수 계산","계수비 적용"},sourceLocation="문항 1",sourceProblem=source};
    private static byte[] Envelope(object v,string finish="stop")=>JsonSerializer.SerializeToUtf8Bytes(new{choices=new[]{new{finish_reason=finish,message=new{content=JsonSerializer.Serialize(v)}}},usage=new{total_tokens=300}});
    [Theory]
    [InlineData("https://127.0.0.1/v1/")]
    [InlineData("http://example.com/v1/")]
    [InlineData("http://user:pass@localhost/v1/")]
    [InlineData("http://localhost/v1/?key=secret")]
    [InlineData("http://localhost/v1/#x")]
    [InlineData("http://localhost/api/")]
    public void RemoteOrUnexpectedAddressRejected(string address)=>Assert.Throws<ArgumentException>(()=>LocalGemmaGenerator.Endpoint(address));
    [Fact] public void LocalAddressNormalized()=>Assert.Equal("http://127.0.0.1:8089/v1/",LocalGemmaGenerator.Endpoint("http://127.0.0.1:8089/v1").AbsoluteUri);
    [Fact] public void ResponseBoundToInputAndLocalModel()
    {
        var d=Draft();var r=LocalGemmaGenerator.ParseResponse(Envelope(Variant(d.Body)),d);
        Assert.Equal(d.Fingerprint(),r.InputFingerprint);Assert.Equal("③ 0.2 mol",r.Answer);Assert.Contains("로컬",r.GenerationNotice);Assert.Contains("300",r.UsageSummary);
    }
    [Fact] public void TruncatedResponseRejected()=>Assert.Throws<InvalidDataException>(()=>LocalGemmaGenerator.ParseResponse(Envelope(Variant(Draft().Body),"length"),Draft()));
    [Fact] public void AnswerNotInChoicesRejected()
    {
        var v=System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(Variant(Draft().Body)))!;v["answerText"]="0.3 mol";
        Assert.Throws<InvalidDataException>(()=>LocalGemmaGenerator.ParseResponse(Envelope(v),Draft()));
    }
    [Fact] public void AnswerNumberDerivedFromValue()
    {
        var v=System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(Variant(Draft().Body)))!;v["answerIndex"]=0;
        Assert.Equal("③ 0.2 mol",LocalGemmaGenerator.ParseResponse(Envelope(v),Draft()).Answer);
    }
    [Fact] public void InventedSourceRejectedEvenForOcr()
    {
        var d=Draft() with{Source=new("x.png","image/png","x","A",10),ReadMethod="Windows OCR"};
        Assert.Throws<InvalidDataException>(()=>LocalGemmaGenerator.ParseResponse(Envelope(Variant("입력에 없는 다른 문제")),d));
    }
    [Fact] public async Task RequestUsesDiscoveredModelAndReadableKoreanWithoutKey()
    {
        var handler=new Handler(async request=>{
            if(request.Method==HttpMethod.Get)return Json(new{data=new[]{new{id="C:/models/gemma-4-12b-it-qat-q4_0.gguf",meta=new{n_ctx=8192}}}});
            Assert.Equal("/v1/chat/completions",request.RequestUri!.AbsolutePath);Assert.False(request.Headers.Contains("Authorization"));
            using var j=JsonDocument.Parse(await request.Content!.ReadAsStringAsync());Assert.Equal("C:/models/gemma-4-12b-it-qat-q4_0.gguf",j.RootElement.GetProperty("model").GetString());
            var content=j.RootElement.GetProperty("messages")[1].GetProperty("content").GetString()!;Assert.Contains("탄산칼슘",content);Assert.DoesNotContain("\\u",content);
            using var source=JsonDocument.Parse(content);
            var properties=j.RootElement.GetProperty("response_format").GetProperty("schema").GetProperty("properties");Assert.False(properties.TryGetProperty("sourceProblem",out _));Assert.Equal(source.RootElement.GetProperty("inputFingerprint").GetString(),properties.GetProperty("inputFingerprint").GetProperty("enum")[0].GetString());
            var variant=System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(Variant(Draft().Body)))!;
            variant["inputFingerprint"]=source.RootElement.GetProperty("inputFingerprint").GetString();
            return new(HttpStatusCode.OK){Content=new ByteArrayContent(Envelope(variant))};
        });
        using var http=new HttpClient(handler);Assert.NotNull(await new LocalGemmaGenerator(http).GenerateAsync(Draft(),LocalGemmaGenerator.DefaultEndpoint));
    }
    [Fact] public async Task WrongModelCannotGenerate()
    {
        var handler=new Handler(_=>Task.FromResult(Json(new{data=new[]{new{id="qwen-7b"}}})));
        using var http=new HttpClient(handler);await Assert.ThrowsAsync<InvalidOperationException>(()=>new LocalGemmaGenerator(http).GenerateAsync(Draft(),LocalGemmaGenerator.DefaultEndpoint));Assert.Equal(1,handler.Calls);
    }
    [Fact] public void FingerprintMismatchRejected()
    {
        var draft=Draft();var variant=System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(Variant(draft.Body)))!;variant["inputFingerprint"]="other-input";
        Assert.Throws<InvalidDataException>(()=>LocalGemmaGenerator.ParseResponse(Envelope(variant),draft,requireFingerprint:true));
    }
    [Fact] public void CompactResponseUsesActualReferenceAndMapsAnswer()
    {
        var draft=Draft();var variant=System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(Variant(draft.Body)))!;variant.AsObject().Remove("sourceProblem");variant["inputFingerprint"]=draft.Fingerprint();
        var result=LocalGemmaGenerator.ParseResponse(Envelope(variant),draft,requireFingerprint:true);
        Assert.Contains(draft.Body,result.SourceProblem);Assert.Equal("③ 0.2 mol",result.Answer);
    }
    [Fact] public async Task SolutionModeReachesTheActualGenerationRequest()
    {
        var draft=new ProblemDraft{Title="풀이 자료",Body="CaCO₃ → CaO + CO₂. 몰질량은 100 g/mol이다. 10 g / 100 g/mol = 0.1 mol. 계수비 1:1로 CO₂는 0.1 mol이다.",FromSolution=true};
        using var http=new HttpClient(new Handler(async request=>{
            if(request.Method==HttpMethod.Get)return Json(new{data=new[]{new{id="gemma-4-12b"}}});
            using var json=JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            var messages=json.RootElement.GetProperty("messages");Assert.Contains("materialKind=solution",messages[0].GetProperty("content").GetString());
            using var source=JsonDocument.Parse(messages[1].GetProperty("content").GetString()!);Assert.Equal("solution",source.RootElement.GetProperty("materialKind").GetString());
            var variant=System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(Variant(draft.Body)))!;variant["inputFingerprint"]=draft.Fingerprint();variant["sourceLocation"]="";return new(HttpStatusCode.OK){Content=new ByteArrayContent(Envelope(variant))};
        }));
        Assert.Equal("③ 0.2 mol",(await new LocalGemmaGenerator(http).GenerateAsync(draft,LocalGemmaGenerator.DefaultEndpoint)).Answer);
        Assert.NotEqual(draft.Fingerprint(),(draft with{FromSolution=false}).Fingerprint());
    }
    [Theory][InlineData(false)][InlineData(true)]public async Task ModelReceivesActualQuantityWithoutSampleRewrite(bool fromSolution)
    {
        var draft=new ProblemDraft{Title="원본 표",FromSolution=fromSolution,Body="A(g)+bB(g)→2C(g)+2D(g). 전체기체 상댓값. b/x × (C의 물질량 + D의 물질량)/(B의 물질량)은?"};
        using var http=new HttpClient(new Handler(async request=>{
            if(request.Method==HttpMethod.Get)return Json(new{data=new[]{new{id="gemma-4-12b"}}});
            using var payload=JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            using var source=JsonDocument.Parse(payload.RootElement.GetProperty("messages")[1].GetProperty("content").GetString()!);
            Assert.Equal(draft.Body,source.RootElement.GetProperty("body").GetString());
            Assert.False(source.RootElement.TryGetProperty("requiredVariantBody",out _));
            Assert.False(payload.RootElement.GetProperty("response_format").GetProperty("schema").GetProperty("properties").GetProperty("body").TryGetProperty("enum",out _));
            return Json(new{choices=new[]{new{finish_reason="stop",message=new{content=JsonSerializer.Serialize(new{status="unsupported",message="질문에서 구하는 양의 조건을 확인해 주세요.",inputFingerprint=draft.Fingerprint()})}}}});
        }));
        if(fromSolution){var error=await Assert.ThrowsAsync<UnsupportedProblemException>(()=>new LocalGemmaGenerator(http).GenerateAsync(draft,LocalGemmaGenerator.DefaultEndpoint));Assert.Contains("구하는 양",error.Message);}
        else{var error=await Assert.ThrowsAsync<InvalidDataException>(()=>new LocalGemmaGenerator(http).GenerateAsync(draft,LocalGemmaGenerator.DefaultEndpoint));Assert.Contains("몰질량",error.Message);}
    }
    [Theory][InlineData(false)][InlineData(true)]public async Task LengthLimitedReplyRetriesSameInputOnce(bool bothTruncated)
    {
        var draft=Draft();var posts=0;
        using var http=new HttpClient(new Handler(async request=>{
            if(request.Method==HttpMethod.Get)return Json(new{data=new[]{new{id="gemma-4-12b"}}});
            using var payload=JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            posts++;Assert.Equal(posts==1?6144:4096,payload.RootElement.GetProperty("max_tokens").GetInt32());
            using var source=JsonDocument.Parse(payload.RootElement.GetProperty("messages")[1].GetProperty("content").GetString()!);
            Assert.Equal(draft.Body,source.RootElement.GetProperty("body").GetString());
            var variant=System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(Variant(draft.Body)))!;
            variant["inputFingerprint"]=draft.Fingerprint();
            return new(HttpStatusCode.OK){Content=new ByteArrayContent(Envelope(variant,posts==1||bothTruncated?"length":"stop"))};
        }));
        if(bothTruncated)await Assert.ThrowsAsync<InvalidDataException>(()=>new LocalGemmaGenerator(http).GenerateAsync(draft,LocalGemmaGenerator.DefaultEndpoint));
        else Assert.Equal("③ 0.2 mol",(await new LocalGemmaGenerator(http).GenerateAsync(draft,LocalGemmaGenerator.DefaultEndpoint)).Answer);
        Assert.Equal(2,posts);
    }
    private static HttpResponseMessage Json(object value)=>new(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(value),Encoding.UTF8,"application/json")};
    private sealed class Handler(Func<HttpRequestMessage,Task<HttpResponseMessage>> send):HttpMessageHandler
    {internal int Calls;protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token){Calls++;return send(request);}}
}

