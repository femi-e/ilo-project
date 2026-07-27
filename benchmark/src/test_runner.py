"""Test runner: injects compressed context, calls MTPLX, records responses."""

import json
import time
import urllib.request
import urllib.error
from typing import Any

from . import config


def call_llm(system_context: str, user_prompt: str) -> dict[str, Any]:
    """Send a request to MTPLX and return the parsed response."""
    messages = []
    if system_context:
        messages.append({"role": "system", "content": system_context})
    messages.append({"role": "user", "content": user_prompt})

    payload = {
        "model": config.MODEL,
        "messages": messages,
        "max_tokens": config.MAX_TOKENS,
        **config.SAMPLING,
    }

    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        config.BASE_URL,
        data=data,
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=1800) as resp:  # 30 min timeout
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return {"error": f"HTTP {e.code}: {body[:200]}"}
    except urllib.error.URLError as e:
        return {"error": f"Connection failed: {e.reason}"}
    except Exception as e:
        return {"error": str(e)}

    msg = result.get("choices", [{}])[0].get("message", {})
    return {
        "content": msg.get("content", ""),
        "reasoning": msg.get("reasoning_content", ""),
        "usage": result.get("usage", {}),
        "raw": result,
    }


def run_test(
    technique_id: str,
    technique_label: str,
    compressed_context: str,
    test_prompts: list[dict[str, str]],
    run_number: int = 1,
) -> list[dict[str, Any]]:
    """Run all test prompts for a given technique.

    Args:
        technique_id: Single letter identifier (A-G)
        technique_label: Human-readable name
        compressed_context: The compressed turn history
        test_prompts: List of {id, prompt, ground_truth, metric}
        run_number: Which run this is (for variance tracking)

    Returns:
        List of results, one per test prompt
    """
    results = []

    for test in test_prompts:
        test_id = test["id"]
        prompt = test["prompt"]
        ground_truth = test.get("ground_truth", "")

        # Call the LLM
        response = call_llm(compressed_context, prompt)

        if "error" in response:
            results.append(
                {
                    "test_id": test_id,
                    "technique": technique_id,
                    "technique_label": technique_label,
                    "run": run_number,
                    "error": response["error"],
                    "response": "",
                    "reasoning": "",
                    "context_size": len(compressed_context),
                }
            )
            continue

        results.append(
            {
                "test_id": test_id,
                "technique": technique_id,
                "technique_label": technique_label,
                "run": run_number,
                "response": response["content"],
                "reasoning": response.get("reasoning", ""),
                "ground_truth": ground_truth,
                "usage": response.get("usage", {}),
                "context_size": len(compressed_context),
            }
        )

        # Brief pause between prompts
        time.sleep(0.5)

    return results
