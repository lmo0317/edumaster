using EduMaster.Core;
using System.Text.Json;
using EduMaster.App;
Console.OutputEncoding=System.Text.Encoding.UTF8;
Console.InputEncoding=System.Text.Encoding.UTF8;
if(args.Length==0||args.Contains("--help")){
    Console.WriteLine("EduMaster 문제·풀이 MVP 개발용 테스트 도구입니다. 일반 화면은 '프로그램 실행.cmd' 또는 웹을 이용하세요.");
    Console.WriteLine("--saved: 저장된 판독 결과로 코드 검산 (AI 호출 없음)");
    Console.WriteLine("--views-only: 원본 이미지 영역 분리 확인 (AI 호출 없음)");
    Console.WriteLine("--gemma-reader: 로컬 Gemma 판독 / --deepseek-reader: DeepSeek API 판독");
    Console.WriteLine("--generate: 판독·검산 후 DeepSeek 생성·검토 추가 (API 비용 발생)");
    Console.WriteLine("--render-only / --text-review-only: 저장된 생성 결과 재검사");
    Console.WriteLine("파일 경로를 생략하면 프로젝트의 문제+해설 원본 샘플을 사용합니다.");
    return 0;
}
string? workspace=null;
try{
    var allowed=new[]{"--saved","--views-only","--gemma-reader","--deepseek-reader","--generate","--render-only","--text-review-only"};
    if(args.Any(a=>a.StartsWith("--")&&!allowed.Contains(a)))throw new ArgumentException("알 수 없는 옵션입니다. --help로 사용법을 확인하세요.");
    if(args.Count(a=>!a.StartsWith("--"))>1)throw new ArgumentException("이미지 파일 한 개만 지정하세요.");
    var suppliedFile=Array.FindIndex(args,a=>!a.StartsWith("--"));
    if(suppliedFile>=0)args[suppliedFile]=Path.GetFullPath(args[suppliedFile]);
    foreach(var start in new[]{AppContext.BaseDirectory,Environment.CurrentDirectory}){
        for(var current=new DirectoryInfo(start);current is not null;current=current.Parent){
            if(File.Exists(Path.Combine(current.FullName,"scripts","material-mvp-smoke","MaterialMvpSmoke.csproj"))&&File.Exists(Path.Combine(current.FullName,"src","EduMaster.Core","EduMaster.Core.csproj"))){workspace=current.FullName;break;}
        }
        if(workspace is not null)break;
    }
    if(workspace is null)throw new DirectoryNotFoundException("프로젝트 위치를 찾지 못했습니다. 'MVP 테스트 실행.cmd'를 이용하세요.");
    Directory.SetCurrentDirectory(workspace);
    await RunAsync(args);
    return Environment.ExitCode;
}catch(Exception e){
    Console.Error.WriteLine("MVP 테스트 실패 · "+(e is OperationCanceledException?"처리 시간이 초과되거나 취소됐습니다.":e.Message));
    Console.Error.WriteLine("이 도구는 개발용 테스트이며 웹 서버를 중단하지 않습니다.");
    if(workspace is not null){
        try{
            var log=Path.Combine(workspace,"artifacts","evidence","web","material-mvp-smoke-error.log");Directory.CreateDirectory(Path.GetDirectoryName(log)!);
            await File.AppendAllTextAsync(log,$"{DateTimeOffset.Now:O}\n{e.GetType().FullName}: {e.Message}\n{e.StackTrace}\n\n");
            Console.Error.WriteLine("오류 기록: "+log);
        }catch(Exception logError){Console.Error.WriteLine("오류 기록 저장 실패 · "+logError.GetType().Name);}
    }
    return 1;
}

static async Task RunAsync(string[] args){
var image=args.FirstOrDefault(a=>!a.StartsWith("--"))??"docs/샘플/샘플자료/원본이미지/02페이지_킬러문제와해설.jpeg";
using var http=new HttpClient{Timeout=TimeSpan.FromSeconds(300)};
using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(300));
var options=new JsonSerializerOptions{WriteIndented=true,PropertyNameCaseInsensitive=true,PropertyNamingPolicy=JsonNamingPolicy.CamelCase,Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping};
if(args.Contains("--render-only")||args.Contains("--text-review-only")){
    var path="artifacts/evidence/web/problem-solution-generated.json";
    var existing=JsonSerializer.Deserialize<SampleResult>(await File.ReadAllTextAsync(path),options)!;
    if(args.Contains("--text-review-only")){
        var steps=ReactionMassCheck.Solve(existing.Body)!.Steps;
        existing=existing with{Explanation=string.Join("\n",steps),Steps=steps};
        existing=await new QualityReviewClient(http).ReviewTextAsync(existing,null,"deepseek","https://api.deepseek.com",DeepSeekVisualGenerator.Model,(await File.ReadAllTextAsync("artifacts/web/deepseek-api-key.txt")).Trim(),token:deadline.Token);
    }else{
        var png=await File.ReadAllBytesAsync("artifacts/evidence/web/problem-solution-output.png");
        var check=await new QualityReviewClient(http).ReviewRenderedAsync(existing,png,false,deadline.Token);
        var checks=existing.Quality!.Checks.Where(c=>c.Id!="render").Append(check).ToArray();
        existing=existing with{Quality=new QualityReport(existing.Quality.Version,checks){RenderHash=check.State=="pass"?Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(png)):null,RenderReviewVersion=QualityReviewClient.RenderVersion}};
    }
    await File.WriteAllTextAsync(path,JsonSerializer.Serialize(existing,options));
    Console.WriteLine(JsonSerializer.Serialize(existing.Quality,options));return;
}
ProblemSolutionMaterial material;
var dataDirectory=Path.GetFullPath("artifacts/evidence/web/material-import");Directory.CreateDirectory(dataDirectory);
var imported=await FileImport.ImportAsync(image,dataDirectory,deadline.Token);
var page=(await LocalDocumentReader.RenderAsync(imported.Source!,dataDirectory,deadline.Token))[0];
var views=await LocalDocumentReader.MaterialViewsAsync(page,deadline.Token);
Console.WriteLine("Image column views: "+views.Length);
await File.WriteAllBytesAsync("artifacts/evidence/web/material-source-page.png",page.Bytes);
for(var i=0;i<views.Length;i++)await File.WriteAllBytesAsync($"artifacts/evidence/web/material-view-{i+1}.png",views[i].Bytes);
if(args.Contains("--views-only"))return;
try{
    if(args.Contains("--saved"))material=ProblemSolutionMaterial.Parse(await File.ReadAllTextAsync("artifacts/evidence/web/problem-solution-read.json"));
    else if(args.Contains("--deepseek-reader"))material=await new DeepSeekVisualGenerator(http).ReadMaterialAsync(page,(await File.ReadAllTextAsync("artifacts/web/deepseek-api-key.txt")).Trim(),deadline.Token,views);
    else{var model=args.Contains("--gemma-reader")?await new LocalGemmaGenerator(http).ProbeAsync(LocalGemmaGenerator.DefaultEndpoint,deadline.Token,true):null;material=await new LocalVisionReader(http).ReadMaterialAsync(page,deadline.Token,model is null?null:LocalGemmaGenerator.DefaultEndpoint,model?.Id,views);}
}
catch(Exception e){if(e.Data["MaterialReply"] is string reply){try{await File.WriteAllTextAsync("artifacts/evidence/web/problem-solution-read-failed.json",reply);}catch(IOException){Console.Error.WriteLine("판독 응답 기록을 저장하지 못했습니다.");}}throw;}
Directory.CreateDirectory("artifacts/evidence/web");
await File.WriteAllTextAsync("artifacts/evidence/web/problem-solution-read.json",JsonSerializer.Serialize(material,options));
Console.WriteLine(JsonSerializer.Serialize(new{material.Body,material.Answer,material.Steps,material.Uncertainties},options));
var draft=new ProblemDraft{Title="문제+풀이 이미지 MVP",Body=material.Body,Answer=material.Answer,Explanation=material.Explanation,Steps=material.Steps,UseSolutionLogic=true};draft.Validate();
ReactionVariantPlan? plan;
plan=ReactionVariantPlan.Create(draft);if(plan is null)throw new InvalidDataException("이 입력을 검산하는 반응량 템플릿을 적용하지 못했습니다.");
var result=plan.Apply(new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),draft.Title,"",[],"","",[],""){SourceProblem=material.Body,Model="코드 템플릿 검사 · 생성 모델 호출 없음"});
var report=ProblemQualityHarness.Inspect(result,draft);
if(report.Checks.Any(c=>c.Method=="code"&&c.State!="pass"))throw new InvalidDataException("코드 검산 실패");
await File.WriteAllTextAsync("artifacts/evidence/web/problem-solution-variant.json",JsonSerializer.Serialize(result with{Quality=report},options));
Console.WriteLine($"CODE PASS: b={plan.Solution.B}; x={plan.Solution.X}; answer={plan.Solution.Answer}; scale={plan.MassScale}; AI/PNG checks pending");
if(args.Contains("--generate")){
    var key=(await File.ReadAllTextAsync("artifacts/web/deepseek-api-key.txt")).Trim();
    var generated=await new DeepSeekVisualGenerator(http).GenerateAsync(draft,key,token:deadline.Token,images:[page]);
    generated=generated with{SourceAnswer=draft.Answer,SourceExplanation=draft.Explanation};
    generated=await new QualityReviewClient(http).ReviewTextAsync(generated,draft,"deepseek","https://api.deepseek.com",DeepSeekVisualGenerator.Model,key,token:deadline.Token);
    await File.WriteAllTextAsync("artifacts/evidence/web/problem-solution-generated.json",JsonSerializer.Serialize(generated,options));
    Console.WriteLine($"MODEL RESULT: {generated.Model}; {generated.Answer}; quality={generated.Quality!.State}; PNG review pending");
}
}
