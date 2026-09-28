using System.Net;
using System.Text.Json;

namespace EduMaster.Core;

public abstract class DeepSeekStopException(string message):InvalidOperationException(message);
public sealed class DeepSeekCallLimitException(int limit):DeepSeekStopException($"이번 작업의 DeepSeek 호출 상한 {limit}회에 도달해 추가 유료 호출을 중단했습니다. 입력과 통과한 초안은 보관합니다.");
public sealed class DeepSeekAccountException() : DeepSeekStopException(
    "DeepSeek 계정 잔액이 부족해 추가 분석·생성을 중단했습니다. 입력은 유지됩니다. 계정 충전 후 다시 시도해 주세요.");

public sealed class DeepSeekAccountClient(HttpClient client)
{
    public async Task EnsureAvailableAsync(string key,CancellationToken token=default)
    {
        if(string.IsNullOrWhiteSpace(key))throw new InvalidOperationException("서버의 DeepSeek API 키를 확인해 주세요.");
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(token);timeout.CancelAfter(TimeSpan.FromSeconds(10));
        using var request=new HttpRequestMessage(HttpMethod.Get,"https://api.deepseek.com/user/balance");
        request.Headers.Authorization=new("Bearer",key.Trim());
        try{
            using var response=await client.SendAsync(request,timeout.Token);
            ThrowIfExhausted(response);
            if(!response.IsSuccessStatusCode)throw new InvalidOperationException("DeepSeek 계정 사용 가능 여부를 확인하지 못했습니다. 유료 요청을 보내지 않았습니다. 잠시 후 다시 시도해 주세요.");
            using var json=JsonDocument.Parse(await FileImport.ReadLimitedAsync(await response.Content.ReadAsStreamAsync(timeout.Token),64*1024,timeout.Token));
            if(!json.RootElement.TryGetProperty("is_available",out var available)||available.ValueKind is not(JsonValueKind.True or JsonValueKind.False))
                throw new InvalidOperationException("DeepSeek 계정 상태 응답을 확인하지 못했습니다. 유료 요청을 보내지 않았습니다.");
            if(!available.GetBoolean())throw new DeepSeekAccountException();
        }catch(OperationCanceledException)when(!token.IsCancellationRequested){throw new TimeoutException("DeepSeek 계정 상태 확인이 지연됐습니다. 유료 요청을 보내지 않았습니다. 다시 시도해 주세요.");}
        catch(HttpRequestException){throw new InvalidOperationException("DeepSeek 계정 서버와 연결하지 못했습니다. 유료 요청을 보내지 않았습니다. 다시 시도해 주세요.");}
        catch(JsonException){throw new InvalidOperationException("DeepSeek 계정 상태 응답을 읽지 못했습니다. 유료 요청을 보내지 않았습니다.");}
    }

    public static void ThrowIfExhausted(HttpResponseMessage response)
    {
        if(response.StatusCode==HttpStatusCode.PaymentRequired)throw new DeepSeekAccountException();
    }
}
