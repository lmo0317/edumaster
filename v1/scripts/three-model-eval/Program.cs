using System.Text.Json;
using EduMaster.Core;

Console.OutputEncoding=System.Text.Encoding.UTF8;
if(args.Length is <1 or >2||args[0] is not("deepseek" or "gemma" or "gpt")||args.Length==2&&args[1]!="--text-only")throw new ArgumentException("deepseek, gemma 또는 gpt, 선택적으로 --text-only를 지정하세요.");
var provider=args[0];
var textOnly=args.Length==2;
var root=Directory.GetCurrentDirectory();
var outputDirectory=Path.Combine(root,"artifacts","three-model-eval");Directory.CreateDirectory(outputDirectory);
var options=new JsonSerializerOptions{WriteIndented=true,PropertyNamingPolicy=JsonNamingPolicy.CamelCase,Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping};
var materialPath=Path.Combine(root,"artifacts","three-model-eval","source-verified.json");
using var material=JsonDocument.Parse(await File.ReadAllTextAsync(materialPath));
var input=material.RootElement;
string Read(string name)=>input.GetProperty(name).GetString()??"";
var steps=input.GetProperty("steps").EnumerateArray().Select(x=>x.GetString()??"").ToArray();
var draft=new ProblemDraft{Title=Read("title"),Body=Read("body"),Answer=Read("answer"),Explanation=Read("explanation"),Steps=steps,UseSolutionLogic=true,SkipDeterministicPlan=true,VariantMode="integrated",
    LogicScope="문제 이미지와 풀이 이미지에서 추출·교정한 문제를 사용한다. 새 문제의 모든 거리·좌표·표 값은 본문과 drawing에 명시한다. 그림 없이는 풀 수 없는 조건을 해설에만 숨기지 않는다. 원본 세 STEP에 각각 대응하는 새 풀이를 작성한다. 새 거리나 속도를 정한 뒤 표의 모든 막전위 칸을 t₁-전도시간-시냅스지연으로 다시 계산하고 활동 전위 그래프의 시각과 대조한다. 원본 표 값을 새 거리 조건에 그대로 복사하지 않는다."};
draft.Validate();
var images=new[]{
    new VisualPage(await File.ReadAllBytesAsync(Path.Combine(root,"question.png")),"image/png",1){MaterialRole="question"},
    new VisualPage(await File.ReadAllBytesAsync(Path.Combine(root,"solution.png")),"image/png",2){MaterialRole="solution"}
};
using var client=new HttpClient{Timeout=TimeSpan.FromMinutes(12)};
using var deadline=new CancellationTokenSource(TimeSpan.FromMinutes(12));
var key=provider=="deepseek"?(await File.ReadAllTextAsync(Path.Combine(root,"artifacts","web","deepseek-api-key.txt"))).Trim():"";
var started=DateTimeOffset.UtcNow;
var output=Path.Combine(outputDirectory,provider+(textOnly?"-text":"")+".json");
var sourceCheck=ProblemQualityHarness.Inspect(new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),draft.Title,draft.Body,[],draft.Answer,draft.Explanation,draft.Steps,"")
    {SourceProblem=draft.Body,SourceAnswer=draft.Answer,SourceExplanation=draft.Explanation},draft)
    .Checks.FirstOrDefault(x=>x.Id=="source-calculation");
if(provider=="gpt"){
    using var document=JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(root,"scripts","three-model-eval","gpt-draft.json")));
    var content=document.RootElement;
    string Field(string key)=>content.GetProperty(key).GetString()??"";
    var result=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),Field("title"),Field("body"),
        content.GetProperty("choices").EnumerateArray().Select(x=>x.GetString()??"").ToArray(),Field("answer"),Field("explanation"),
        content.GetProperty("steps").EnumerateArray().Select(x=>x.GetString()??"").ToArray(),Field("changeSummary")){
        SourceProblem=draft.Body,SourceAnswer=draft.Answer,SourceExplanation=draft.Explanation,SourceSteps=draft.Steps,
        Model="GPT 시뮬레이션 (assistant-authored)",RuntimeModelId="conversation-assistant",
        Graph=new ProblemGraph("line","흥분 도착 후 막전위","시간(ms)","막전위(mV)",[0,1,1.5,2,2.5,3,4],[-70,-60,0,30,0,-80,-70]),
        Drawings=[new ProblemDrawing("지점과 시냅스 후보",1000,220,"d₁=0, d₂=3, d₃=7.5, d₄=10.5 cm; d₃ 자극",[
            new DrawingElement("line",[100,100,900,100],"",20,false,"none"),
            new DrawingElement("text",[100,60],"d₁ 0cm",20,false,"none"),
            new DrawingElement("text",[330,60],"d₂ 3cm",20,false,"none"),
            new DrawingElement("text",[670,60],"d₃ 7.5cm 자극",20,false,"none"),
            new DrawingElement("text",[850,60],"d₄ 10.5cm",20,false,"none"),
            new DrawingElement("text",[215,150],"ⓐ",20,false,"none"),
            new DrawingElement("text",[500,150],"ⓑ",20,false,"none"),
            new DrawingElement("text",[770,150],"ⓒ",20,false,"none")
        ])],RequiresVisuals=true
    };
    var quality=ProblemQualityHarness.Inspect(result,draft);
    await File.WriteAllTextAsync(output,JsonSerializer.Serialize(new{provider,state="review_required",started,finished=DateTimeOffset.UtcNow,
        sourceCheck,result.Title,result.Body,result.Choices,result.Answer,result.Explanation,result.Steps,result.ChangeSummary,result.Model,result.RuntimeModelId,
        result.Graph,result.Diagrams,result.Drawings,Quality=quality,manualArithmeticChecks=new[]{
            "A: d₃→d₄ = 3 cm ÷ 3 cm/ms = 1 ms; t₁=1+3=4 ms",
            "A: d₃→d₂ = 4.5 cm ÷ 3 = 1.5 ms; 경과 2.5 ms → 0 mV",
            "A: d₃→d₁ = 7.5 cm ÷ 3 = 2.5 ms; 경과 1.5 ms → 0 mV",
            "B: d₃→d₂ = 4.5 cm ÷ 1.5 = 3 ms; 경과 1 ms → -60 mV",
            "B: d₃→d₄ = 3 cm ÷ 1.5 = 2 ms; 시냅스 지연 0.5 ms면 경과 1.5 ms → 0 mV"
        }},options));
    Console.WriteLine("gpt simulation result: "+quality.State+"; answerVerified="+quality.AnswerVerified);
    return;
}
try{
    var progress=new Progress<string>(s=>Console.WriteLine(provider+": "+s));
    SampleResult? result=null;
    Exception? lastError=null;
    for(var attempt=1;attempt<=3&&result is null;attempt++){
        try{
            result=provider=="deepseek"
                ?await new DeepSeekVisualGenerator(client).GenerateAsync(draft,key,progress,deadline.Token,textOnly?null:images)
                :await new LocalGemmaGenerator(client).GenerateAsync(draft,LocalGemmaGenerator.ConfiguredEndpoint,progress,deadline.Token,textOnly?null:images);
        }catch(InvalidDataException e)when(attempt<3){lastError=e;Console.WriteLine($"{provider}: 응답 구조 보정 재시도 {attempt}/2 · {e.Message}");}
    }
    if(result is null)throw lastError??new InvalidDataException("모델 결과를 받지 못했습니다.");
    await File.WriteAllTextAsync(output,JsonSerializer.Serialize(new{provider,state="model_draft",started,sourceCheck,result.Title,result.Body,result.Choices,result.Answer,result.Explanation,result.Steps,result.ChangeSummary,result.Model,result.RuntimeModelId,result.UsageSummary,result.Graph,result.Diagrams,result.Drawings},options));
    var reviewed=await new QualityReviewClient(client).ReviewTextAsync(result,draft,provider,provider=="deepseek"?"https://api.deepseek.com":LocalGemmaGenerator.ConfiguredEndpoint,
        provider=="deepseek"?DeepSeekVisualGenerator.Model:result.RuntimeModelId,key,progress,deadline.Token);
    await File.WriteAllTextAsync(output,JsonSerializer.Serialize(new{provider,state="reviewed",started,finished=DateTimeOffset.UtcNow,sourceCheck,reviewed.Title,reviewed.Body,reviewed.Choices,reviewed.Answer,reviewed.Explanation,reviewed.Steps,reviewed.ChangeSummary,reviewed.Model,reviewed.RuntimeModelId,reviewed.UsageSummary,reviewed.Graph,reviewed.Diagrams,reviewed.Drawings,reviewed.Quality},options));
    Console.WriteLine(provider+" result: "+reviewed.Quality?.State+"; answerVerified="+reviewed.Quality?.AnswerVerified);
}catch(Exception e){
    await File.WriteAllTextAsync(output,JsonSerializer.Serialize(new{provider,state="failed",started,finished=DateTimeOffset.UtcNow,sourceCheck,error=e.GetType().Name+": "+e.Message},options));
    Console.WriteLine(provider+" failed: "+e.Message);
}
